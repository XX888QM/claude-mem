import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../shared/paths.js';

const USAGE_FILE_PREFIX = 'codex-usage-';
const USAGE_FILE_PATTERN = /^codex-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const USAGE_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CodexCliUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexUsageMeterEvent {
  eventId: string;
  model: string;
  project: string;
  sessionId: string;
  usage: CodexCliUsage;
  timestamp?: Date;
}

export function getCodexUsageDirectory(dataDir = DATA_DIR): string {
  return join(dataDir, 'usage');
}

export function pruneCodexUsageFiles(
  usageDir: string,
  now = Date.now(),
  retentionDays = USAGE_RETENTION_DAYS,
): number {
  if (!existsSync(usageDir)) return 0;

  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
  let removed = 0;
  try {
    for (const name of readdirSync(usageDir)) {
      const match = USAGE_FILE_PATTERN.exec(name);
      if (!match || match[1] >= cutoff) continue;
      try {
        unlinkSync(join(usageDir, name));
        removed += 1;
      } catch {
        // Best-effort retention must never interrupt observation generation.
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

export function recordCodexUsage(
  event: CodexUsageMeterEvent,
  usageDir = getCodexUsageDirectory(),
): boolean {
  if (!isValidEvent(event)) return false;

  const timestamp = event.timestamp ?? new Date();
  const day = timestamp.toISOString().slice(0, 10);
  try {
    mkdirSync(usageDir, { recursive: true });
    pruneCodexUsageFiles(usageDir, timestamp.getTime());
    appendFileSync(
      join(usageDir, `${USAGE_FILE_PREFIX}${day}.jsonl`),
      JSON.stringify({
        type: 'claude_mem.codex_usage',
        schema_version: 1,
        timestamp: timestamp.toISOString(),
        event_id: event.eventId,
        model: event.model,
        project: event.project,
        session_id: event.sessionId,
        usage: {
          input_tokens: event.usage.inputTokens,
          cached_input_tokens: event.usage.cachedInputTokens,
          cache_write_input_tokens: event.usage.cacheWriteInputTokens,
          output_tokens: event.usage.outputTokens,
          reasoning_output_tokens: event.usage.reasoningOutputTokens,
        },
      }) + '\n',
      'utf8',
    );
    return true;
  } catch (error) {
    process.stderr.write(
      `[CODEX-USAGE] failed to write: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

function isValidEvent(event: CodexUsageMeterEvent): boolean {
  if (!event.eventId || !event.model || !event.project) return false;
  return Object.values(event.usage).every(value => Number.isSafeInteger(value) && value >= 0)
    && event.usage.cachedInputTokens <= event.usage.inputTokens;
}
