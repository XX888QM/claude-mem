import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { buildInitPrompt, buildObservationBatchPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { optimizeObservationFields, buildFieldCompressionPrompt } from './field-optimizer.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { resolveSummaryTierModel } from './model-aliases.js';
import { isClassified, type ClassifiedProviderError } from './provider-errors.js';
import {
  shouldRecycleConversation,
  conversationChars,
  resolveConversationMaxChars,
} from '../../shared/observer-recycle.js';
import { recycleObserverConversation, loadSessionStartContext } from './session/recycle-conversation.js';
import { buildTelegramWrapupPrompt, type TelegramWrapupFormatterInput } from '../integrations/TelegramWrapupNotifier.js';
import {
  processAgentResponse,
  snapshotResponseContext,
  isAbortError,
  type WorkerRef
} from './agents/index.js';

/**
 * Normalized result returned by a concrete provider's `query()`.
 * Optional fields (costUsd, servedModel) are populated only by providers that
 * surface them; absent fields are simply not forwarded.
 */
export interface ProviderQueryResult {
  content: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Real provider-reported spend in USD (only some gateways report it). */
  costUsd?: number;
  /** The model that actually served the request, when reported. */
  servedModel?: string;
}

/**
 * Shared scaffolding for OpenAI-compatible, multi-turn HTTP providers
 * (Gemini, OpenRouter). The session lifecycle — synthetic memory-session-id
 * generation, init/continuation prompt, the observation/summary message loop,
 * cumulative token accounting, abort-aware error handling, and history
 * truncation — is identical between them. Per-provider differences (config
 * resolution, request shape, token estimation, usage/cost reporting) are
 * supplied by abstract members.
 */
export abstract class OpenAICompatibleProvider<TConfig extends { apiKey: string; model: string; plainText?: boolean }> {
  protected dbManager: DatabaseManager;
  protected sessionManager: SessionManager;

  /** Human-readable provider name passed to logging + processAgentResponse. */
  protected abstract readonly providerName: string;
  /** Prefix for the synthetic memorySessionId (e.g. 'gemini', 'openrouter'). */
  protected abstract readonly syntheticIdPrefix: string;
  /**
   * When a query returns empty content for an observation/summary message:
   * OpenRouter still calls processAgentResponse('') (forwards the empty batch
   * to the parser/recovery path); Gemini skips it and logs a warning. This flag
   * preserves that per-provider divergence.
   */
  protected abstract readonly forwardEmptyMessageResponse: boolean;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /** Resolve API key, model, and any per-provider request parameters. */
  protected abstract getConfig(): TConfig;

  /** Throw a provider-specific "API key not configured" error. */
  protected abstract missingApiKeyError(): Error;

  /** Issue the actual HTTP request and normalize its response. */
  protected abstract query(
    history: ConversationMessage[],
    config: TConfig,
    session?: ActiveSession,
  ): Promise<ProviderQueryResult>;

  /**
   * One bounded, standalone call that condenses an oversized tool payload.
   *
   * Issued off to the side with its own single-message history: adding it to
   * `session.conversationHistory` would grow the very conversation the recycle
   * logic exists to bound.
   */
  private async compressField(text: string, budgetChars: number, config: TConfig, _signal: AbortSignal): Promise<string | null> {
    const result = await this.query(
      [{ role: 'user', content: buildFieldCompressionPrompt(text, budgetChars) }],
      config,
    );
    return result.content || null;
  }

  /** Format a stored summary through this provider's normal summary-model query path. */
  async formatTelegramWrapup(
    input: TelegramWrapupFormatterInput,
    activeModelId?: string,
  ): Promise<string> {
    const config = this.getConfig();
    if (!config.apiKey) {
      throw this.missingApiKeyError();
    }
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = resolveSummaryTierModel(activeModelId ?? config.model, settings);
    const summaryConfig = { ...config, model, plainText: true };
    const result = await this.query(
      [{ role: 'user', content: buildTelegramWrapupPrompt(input.summaryText) }],
      summaryConfig,
    );
    if (!result.content?.trim()) {
      const error = new Error(`${this.providerName} returned no text for the Telegram wrap-up`);
      logger.error('TELEGRAM', error.message, { sessionId: input.sessionDbId, model }, error);
      throw error;
    }
    return result.content;
  }

  /** Estimate token count for a single message body. */
  protected abstract estimateTokens(text: string): number;

  /** Build the session.lastUsage value from a query result. */
  protected abstract buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'];

  /** Hook for per-session setup that runs once config is resolved (e.g. endpointClass). */
  protected prepareSessionExtras(_session: ActiveSession, _config: TConfig): void {}

  /**
   * Whether to spend an LLM call on the large init/continuation skeleton before
   * draining the observation/summary queue. Stateless CLI providers (Grok) should
   * return false — each task is a fresh single-shot call.
   */
  protected shouldRunInitQuery(): boolean {
    return true;
  }

  /**
   * Select which conversation turns to send to the model. Default: full history.
   * Stateless CLI providers can return only the latest user turn.
   */
  protected selectHistoryForQuery(history: ConversationMessage[]): ConversationMessage[] {
    return history;
  }

  /** Allow providers to apply summary-only model settings per batch. */
  protected getSummaryConfig(config: TConfig): TConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const summaryModel = resolveSummaryTierModel(config.model, settings);
    if (summaryModel === config.model) return config;

    logger.debug('SESSION', 'Tier routing: summary model', {
      model: summaryModel,
    });
    return { ...config, model: summaryModel };
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getConfig();
    const { apiKey, model } = config;
    session.lastModelId = model;
    this.prepareSessionExtras(session, config);

    if (!apiKey) {
      throw this.missingApiKeyError();
    }

    if (!session.memorySessionId) {
      const persistedMemorySessionId = this.dbManager.getSessionById(session.sessionDbId).memory_session_id;
      const syntheticIdPrefix = `${this.syntheticIdPrefix}-${session.contentSessionId}-`;

      if (persistedMemorySessionId?.startsWith(syntheticIdPrefix)) {
        session.memorySessionId = persistedMemorySessionId;
        logger.info('SESSION', `MEMORY_ID_REUSED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      } else {
        const syntheticMemorySessionId = `${syntheticIdPrefix}${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      }
    }

    const mode = ModeManager.getInstance().getActiveMode();

    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
    const initContext = snapshotResponseContext(session);

    const initHistoryLength = session.conversationHistory.length;
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    if (this.shouldRunInitQuery()) {
      try {
        session.lastPromptSentAt = Date.now();
        session.lastGeneratorSource = 'init';
        const initResponse = await this.query(
          this.selectHistoryForQuery(session.conversationHistory),
          config,
          session,
        );
        await this.handleInitResponse(initResponse, session, worker, model, initContext);
      } catch (error: unknown) {
        if (isClassified(error)) {
          logger.debug('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
        } else if (error instanceof Error) {
          logger.error('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model }, error);
        } else {
          logger.error('SDK', `${this.providerName} init query failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
        }
        session.conversationHistory.length = initHistoryLength;
        return this.handleSessionError(error, session, worker);
      }
    } else {
      session.lastGeneratorSource = 'init';
      logger.info('SDK', `${this.providerName} skipping init model call (stateless single-shot mode)`, {
        sessionId: session.sessionDbId,
        model,
      });
    }

    try {
      await this.runMessageLoop(session, worker, config, mode);
    } catch (error: unknown) {
      if (isClassified(error)) {
        logger.debug('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
      } else if (error instanceof Error) {
        logger.error('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${this.providerName} message loop failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleSessionError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', `${this.providerName} agent completed`, {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async runMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const batch of this.sessionManager.getMessageBatchIterator(session.sessionDbId)) {
      const message = batch[0];
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;
      const messageHistoryLength = session.conversationHistory.length;

      try {
        if (message.type === 'observation') {
          await this.processObservationMessages(session, batch, worker, config, originalTimestamp, lastCwd);
        } else if (message.type === 'summarize') {
          await this.processSummaryMessage(session, message, worker, config, mode, originalTimestamp, lastCwd);
        }
      } catch (error) {
        // Only erase the prompt/response when the claimed queue item still
        // exists and can actually be retried. processAgentResponse confirms
        // the item immediately after durable SQLite storage; a later
        // broadcast/sync failure must not erase that already-completed turn.
        const retryableMessages = this.sessionManager.getClaimedMessages(session.sessionDbId);
        if (retryableMessages.length > 0) {
          session.conversationHistory.length = messageHistoryLength;
        }
        throw error;
      }
    }
  }

  private async handleInitResponse(
    initResponse: ProviderQueryResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string,
    responseContext: ReturnType<typeof snapshotResponseContext>
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(initResponse);
      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, this.providerName, undefined, initResponse.servedModel ?? model, responseContext
      );
      return;
    }

    if (!this.forwardEmptyMessageResponse) {
      logger.error('SDK', `Empty ${this.providerName} init response - session may lack context`, {
        sessionId: session.sessionDbId, model
      });
      return;
    }

    const tokensUsed = initResponse.tokensUsed || 0;
    session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
    session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    // The init prompt carries the user's request and no tool call, so nothing in
    // its reply can be an observation of this session — an <observation> here was
    // invented from <user_request> alone and would be stored as memory for work
    // that never happened. Keep the turn so role alternation holds, but never
    // hand it to the storage path.
    session.conversationHistory.push({ role: 'assistant', content: initResponse.content || '' });
  }

  private async processObservationMessages(
    session: ActiveSession,
    messages: PendingMessageWithId[],
    worker: WorkerRef | undefined,
    config: TConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    const message = messages[0];
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationBatchPrompt(messages.map(item => ({
      id: 0,
      tool_name: item.tool_name!,
      tool_input: JSON.stringify(item.tool_input),
      tool_output: JSON.stringify(item.tool_response),
      created_at_epoch: item._originalTimestamp,
      cwd: item.cwd
    })));
    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const obsResponse = await this.query(
      this.selectHistoryForQuery(session.conversationHistory),
      config,
      session,
    );

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      // Both sides or nothing: a backend reporting only one of the two counts
      // must not produce a half-real event (input=0 → compression_ratio 0.0).
      session.lastUsage = this.buildLastUsage(obsResponse);
    }

    if (obsResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        obsResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, obsResponse.servedModel ?? config.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} observation response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);
    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'summarize';
    const summaryConfig = this.getSummaryConfig(config);
    const summaryResponse = await this.query(
      this.selectHistoryForQuery(session.conversationHistory),
      summaryConfig,
      session,
    );

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(summaryResponse);
    }

    if (summaryResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        summaryResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, summaryResponse.servedModel ?? summaryConfig.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} summary response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  /**
   * Map a classified provider failure onto the abortReason category that keeps
   * buffered work alive.
   *
   * handleGeneratorExit finalizes the session — dropping whatever is buffered —
   * for every category outside its preserve list. Quota was only ever set by
   * the two PROACTIVE sites (the pre-request rate-limit guard and the
   * observer-text heuristic), so a real 429 coming back from the provider left
   * abortReason null and the session was torn down as if the failure were
   * fatal (#3700). These conditions clear on their own; the work should still
   * be there when they do.
   */
  private preservingAbortReason(error: ClassifiedProviderError): string | null {
    switch (error.kind) {
      case 'quota_exhausted':
      case 'rate_limit':
        return `quota:${error.kind}`;
      // Same shape, same list: handleGeneratorExit already honours 'auth', and
      // credentials that are fixed by /login are no more fatal than a 429.
      case 'auth_invalid':
        return `auth:${error.kind}`;
      // A timeout or network fault that outlived the retry policy. Finalizing
      // would turn it into permanent data loss — the same reasoning as the
      // observer-text transport path in ResponseProcessor (#3752).
      case 'transient':
        return `transport:${error.kind}`;
      default:
        return null;
    }
  }

  protected handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', `${this.providerName} agent aborted`, { sessionId: session.sessionDbId });
      throw error;
    }

    if (isClassified(error)) {
      // Set BEFORE the rethrow: the .finally() in SessionRoutes reads
      // session.abortReason to decide whether to finalize the session, so a
      // reason recorded after unwinding would arrive too late to matter.
      const preserving = this.preservingAbortReason(error);
      if (preserving !== null) {
        session.abortReason = preserving;
        // Abort as well as label. Without it the controller stays live while
        // the error unwinds, and the session route books the failure twice —
        // an observer failure and an error outcome on the way out, then the
        // aborted outcome at finalization — leaving observer-health marked
        // failed for a pause that is not a failure. This is what the two
        // observer-text paths already do for the same conditions.
        try {
          session.abortController.abort();
        } catch {
          // best-effort; AbortController.abort() should not throw in normal use.
        }
        logger.warn('SDK', `${this.providerName} paused on ${error.kind}; preserving buffered work`, {
          sessionId: session.sessionDbId,
          kind: error.kind,
        });
      }

      // Logged once at SessionRoutes' `Observer failed` line.
      logger.debug('SDK', `${this.providerName} agent error`, { sessionDbId: session.sessionDbId, kind: error.kind }, error);
    } else {
      logger.failure('SDK', `${this.providerName} agent error`, { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }

}
