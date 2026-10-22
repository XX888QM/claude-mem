import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';
import { SESSION_IDLE_TIMEOUT_MS } from '../SessionMessageBuffer.js';
import { abortCategoryOf, PRESERVED_ABORT_CATEGORIES } from './abort-reason.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  bufferedWorkRetentionMs?: number;
  /**
   * Start a fresh generator for this session on the next tick (the runner's
   * resumeGeneratorLater). Used only for buffered work that finalizing would
   * otherwise dispose of: work that arrived while an idle generator was
   * stopping, and one rescue of a summarize after an unclassified failure.
   */
  resumeGenerator?: (source: string) => void;
}

/**
 * Post-generator-exit handler.
 *
 * The generator's message iterator only ends on abort (idle / shutdown) or when
 * the SDK stream throws, so most exits mean this session is done. Quota exits
 * are different: claimed work has already been reset to pending, so leave the
 * session and in-RAM buffer alive for a later generator start.
 *
 * Any exit that leaves buffered work behind (quota, exec timeout, spawn
 * failure, idle race) preserves the session and its in-RAM buffer instead of
 * finalizing: buffered work lives only in RAM, so finalize → dispose would
 * silently delete it. We still do NOT respawn here — the old respawn-on-pending
 * loop was the retry storm. Continuation happens naturally: the next
 * observation ingest (or /api/sessions/init) calls ensureGeneratorRunning,
 * which starts a fresh generator that drains whatever is buffered. Only a
 * clean exit with an empty buffer finalizes and removes the session. Retained
 * non-quota work gets one normal idle window to resume.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  // 'overflow' joins quota/auth as a pause-and-preserve exit: ResponseProcessor
  // has already reset the claimed batch to pending and (on a recycle) cleared
  // the conversation, so the session must survive for the next ingest to open a
  // fresh generator and drain it. Finalizing here would drop that work (#3800).
  // 'provider_switch' (#2756) is the same shape for a different reason:
  // SessionRoutes aborted a generator that was PARKED in waitForSlot (never
  // acquired a slot / never spawned), or a running generator ended at a
  // message boundary (#4846), to switch providers, and a fresh generator for
  // the newly-selected provider starts on this same session —
  // finalizeSession + removeSessionImmediate would dispose the
  // in-RAM buffer (SessionManager.removeSessionImmediate -> buffer.dispose),
  // wiping the very queue the switch is meant to preserve. The transcript is
  // not carried over: every generator start opens a new generation seeded from
  // the session's memory (#3800, #3479), so the queue is what must survive.
  const abortCategory = abortCategoryOf(reason);
  // Every category listed here has ALREADY called resetProcessingToPending
  // (except provider_switch, which parks a live buffer for a provider change).
  // Falling through to finalizeSession would remove the session and undo that
  // preservation — the second half of #3752.
  // 'output_retry' is a queued batch whose reply was neither XML nor the skip
  // sentinel: ResponseProcessor reset it to pending for one more try in a
  // fresh generation, which the runner starts on the next tick. 'drift' ends a
  // generation that kept leaving the observation schema; its batches were
  // already stored, and buffered work continues in a fresh generation.
  // The full list lives in abort-reason.ts, beside the telemetry enum.
  // Every transport pause resumes on the transport backoff — a deadline or an
  // upstream fault that outlived the provider's retries, whatever code it
  // carries, and a transport failure the Claude CLI returned as text — except a
  // response stall, which the runner resumes on its own bounded schedule.
  const resumesOnTransportBackoff = abortCategory === 'transport' && reason !== 'transport:response_stall';
  // A later run may finish for a different reason before an earlier transport
  // timer fires. Its old timer must not bypass the new pause decision.
  if (!resumesOnTransportBackoff) {
    sessionManager.clearTransportResume?.(sessionDbId);
  }
  if (PRESERVED_ABORT_CATEGORIES.has(abortCategory)) {
    session.pausedReason = abortCategory;
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
    });
    if (resumesOnTransportBackoff) {
      sessionManager.scheduleTransportResume?.(sessionDbId);
    }
    return;
  }

  // Claimed-but-unconfirmed messages count as buffered work too.
  await sessionManager.resetProcessingToPending(sessionDbId);
  const pendingCount = sessionManager.getMessageBuffer().getPendingCount(sessionDbId);
  if (pendingCount > 0) {
    logger.warn('SESSION', 'Generator exited with buffered work; preserving session (finalize would dispose it)', {
      sessionId: sessionDbId,
      reason,
      pendingCount,
    });
    if (session.retainedWorkCleanupTimer) {
      clearTimeout(session.retainedWorkCleanupTimer);
    }
    session.retainedWorkCleanupTimer = setTimeout(() => {
      session.retainedWorkCleanupTimer = undefined;
      if (sessionManager.getSession(sessionDbId) !== session || session.generatorPromise) {
        return;
      }

      logger.warn('SESSION', 'Buffered-work retention window expired; finalizing abandoned session', {
        sessionId: sessionDbId,
        pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
      });
      try {
        completionHandler.finalizeSession(sessionDbId);
      } catch (e) {
        const normalized = e instanceof Error ? e : new Error(String(e));
        logger.error('SESSION', 'Deferred finalization failed; forcing in-memory session removal', {
          sessionId: sessionDbId,
        }, normalized);
      } finally {
        sessionManager.removeSessionImmediate(sessionDbId);
      }
    }, deps.bufferedWorkRetentionMs ?? SESSION_IDLE_TIMEOUT_MS);
    session.retainedWorkCleanupTimer.unref?.();
    return;
  }

  logger.info('SESSION', 'Generator exited — finalizing session', { sessionId: sessionDbId, reason });

  try {
    completionHandler.finalizeSession(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Finalization failed; forcing in-memory session removal', {
      sessionId: sessionDbId,
      reason
    }, normalized);
  } finally {
    sessionManager.removeSessionImmediate(sessionDbId);
  }
}
