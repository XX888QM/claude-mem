// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  DATA_DIR,
  ensureDir,
  OBSERVER_SESSIONS_DIR,
  USER_SETTINGS_PATH,
} from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { resolveGrokSpawnInvocation } from '../integrations/GrokCliInstaller.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError, isClassified } from './provider-errors.js';

interface GrokConfig {
  apiKey: string;
  model: string;
  reasoningEffort: string;
}

export const DEFAULT_GROK_MODEL = 'grok-4.5';
export const DEFAULT_GROK_REASONING_EFFORT = 'medium';
export const OBSERVER_GROK_HOME = join(DATA_DIR, 'observer-grok-home');

const GROK_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const MAX_CONTEXT_MESSAGES = 1; // Grok CLI is single-shot; only latest task
const MAX_ESTIMATED_TOKENS = 8_000; // ~keep prompt small enough for headless reliability
const MAX_PROMPT_CHARS = 24_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const GROK_EXEC_TIMEOUT_MS = 180_000;
const GROK_QUOTA_RETRY_COOLDOWN_MS = 5 * 60_000;
const GROK_BUSY_COOLDOWN_MS = 90_000;
const DEFAULT_MAX_CONCURRENT_GROK = 2;

let grokQuotaBlockedUntil = 0;
let activeGrokExecs = 0;
const grokSlotWaiters: Array<() => void> = [];

const OBSERVER_SYSTEM_RULES = [
  'You are the claude-mem observer. Output ONLY valid claude-mem XML. No Markdown. No prose.',
  'Do not call tools. Do not explain.',
  '',
  'TWO legal root tags (pick exactly one):',
  '',
  '1) Observation (for tool-use ingest):',
  '<observation>',
  '  <type>discovery|bugfix|feature|refactor|decision|change</type>',
  '  <title>short title</title>',
  '  <subtitle>one line</subtitle>',
  '  <facts>["fact1","fact2"]</facts>',
  '  <narrative>paragraph</narrative>',
  '  <concepts>["how-it-works"]</concepts>',
  '  <files_read>[]</files_read>',
  '  <files_modified>[]</files_modified>',
  '</observation>',
  '',
  '2) Progress summary (ONLY when the user message contains MODE SWITCH: PROGRESS SUMMARY):',
  '<summary>',
  '  <request>...</request>',
  '  <investigated>...</investigated>',
  '  <learned>...</learned>',
  '  <completed>...</completed>',
  '  <next_steps>...</next_steps>',
  '  <notes>...</notes>',
  '</summary>',
  '',
  'NEVER put observation fields (type/title/facts/narrative) inside <summary>.',
  'NEVER put summary fields (request/investigated/learned) inside <observation>.',
  'If nothing durable to store, return empty output with no tags.',
].join('\n');

export class GrokProvider extends OpenAICompatibleProvider<GrokConfig> {
  protected readonly providerName = 'Grok';
  protected readonly syntheticIdPrefix = 'grok';
  // Empty content is treated as intentional skip (idle) and confirmed.
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  /** Each Grok CLI exec is a fresh process — do not burn a call on the huge init skeleton. */
  protected shouldRunInitQuery(): boolean {
    return false;
  }

  /** Single-shot: only the latest user task, not multi-turn history. */
  protected selectHistoryForQuery(history: ConversationMessage[]): ConversationMessage[] {
    if (history.length === 0) return history;
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    return lastUser ? [lastUser] : [history[history.length - 1]];
  }

  protected getConfig(): GrokConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      apiKey: 'grok-cli',
      model: settings.CLAUDE_MEM_GROK_MODEL || DEFAULT_GROK_MODEL,
      reasoningEffort: normalizeReasoningEffort(settings.CLAUDE_MEM_GROK_REASONING_EFFORT),
    };
  }

  protected override getSummaryConfig(config: GrokConfig): GrokConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_SUMMARY_PROVIDER !== 'grok') return config;

    return {
      ...config,
      model: settings.CLAUDE_MEM_SUMMARY_MODEL || config.model,
      reasoningEffort: normalizeReasoningEffort(settings.CLAUDE_MEM_SUMMARY_EFFORT),
    };
  }

  protected missingApiKeyError(): Error {
    return new Error('Grok CLI is not available. Install Grok and sign in before selecting the Grok provider.');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(_result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return null;
  }

  protected async query(
    history: ConversationMessage[],
    config: GrokConfig,
    session?: ActiveSession,
  ): Promise<ProviderQueryResult> {
    // Enforce cooldown at query time (not only at generator start) so pool waiters
    // cannot bypass a rate/quota pause that landed while they were queued.
    if (isGrokQuotaCooldownActive()) {
      throw new ClassifiedProviderError('Grok cooldown active', {
        kind: 'rate_limit',
        cause: new Error(`retry in ${getGrokQuotaCooldownRemainingMs()}ms`),
      });
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = Math.max(
      1,
      parseInt(settings.CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || DEFAULT_MAX_CONCURRENT_GROK,
    );

    const releaseSlot = await acquireGrokSlot(maxConcurrent, session?.abortController.signal);

    // Re-check after waiting for a slot — another call may have entered cooldown.
    if (isGrokQuotaCooldownActive()) {
      releaseSlot();
      throw new ClassifiedProviderError('Grok cooldown active', {
        kind: 'rate_limit',
        cause: new Error(`retry in ${getGrokQuotaCooldownRemainingMs()}ms`),
      });
    }

    const truncated = this.truncateHistory(history).map(message => ({
      ...message,
      content: clipPromptContent(message.content, MAX_PROMPT_CHARS),
    }));
    const prompt = [
      OBSERVER_SYSTEM_RULES,
      '',
      ...truncated.map((message, index) => (
        `--- ${index + 1} ${message.role} ---\n${message.content}`
      )),
    ].join('\n');

    ensureDir(OBSERVER_SESSIONS_DIR);
    const workDir = mkdtempSync(join(OBSERVER_SESSIONS_DIR, 'grok-'));
    const promptPath = join(workDir, 'prompt.txt');
    writeFileSync(promptPath, prompt, 'utf-8');
    const args = buildGrokExecArgs(
      config.model,
      promptPath,
      workDir,
      config.reasoningEffort,
    );
    const grokHome = ensureObserverGrokHome();

    try {
      logger.info('SDK', 'Querying Grok', {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        turns: truncated.length,
        promptChars: prompt.length,
        activeGrokExecs,
        maxConcurrent,
        grokHome,
        source: session?.lastGeneratorSource,
      });
      try {
        const content = await runGrokExec(args, session?.abortController.signal, grokHome);
        const normalized = normalizeGrokObserverXml(sanitizeGrokOutput(content));
        if (!normalized) {
          // Nothing to store — return empty so the parent can skip without
          // treating this as a hard generator crash / global cooldown.
          logger.info('SDK', 'Grok returned empty observer output (skip)', {
            sessionId: session?.sessionDbId,
            source: session?.lastGeneratorSource,
          });
          return { content: '', servedModel: config.model };
        }
        if (isGrokLimitProse(normalized)) {
          throw new ClassifiedProviderError('Grok session limit reached', {
            kind: 'quota_exhausted',
            cause: new Error(normalized.slice(0, 200)),
          });
        }
        if (!looksLikeObserverXml(normalized)) {
          // Format failure: log and skip this batch rather than thrashing.
          logger.warn('SDK', 'Grok returned non-protocol text; skipping batch', {
            sessionId: session?.sessionDbId,
            preview: normalized.slice(0, 160),
          });
          return { content: '', servedModel: config.model };
        }
        grokQuotaBlockedUntil = 0;
        return { content: normalized, servedModel: config.model };
      } catch (error) {
        if (
          session
          && isClassified(error)
          && (error.kind === 'quota_exhausted' || error.kind === 'rate_limit')
        ) {
          const cooldown = error.kind === 'quota_exhausted'
            ? GROK_QUOTA_RETRY_COOLDOWN_MS
            : GROK_BUSY_COOLDOWN_MS;
          grokQuotaBlockedUntil = Date.now() + cooldown;
          await this.sessionManager.resetProcessingToPending(session.sessionDbId);
          session.abortReason = `quota:grok_${error.kind}`;
          session.abortController.abort();
        }
        throw error;
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      releaseSlot();
    }
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const kept: ConversationMessage[] = [];
    let estimatedTokens = 0;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      const messageTokens = this.estimateTokens(message.content);
      if (
        kept.length >= MAX_CONTEXT_MESSAGES
        || estimatedTokens + messageTokens > MAX_ESTIMATED_TOKENS
      ) {
        if (kept.length === 0) {
          kept.unshift(message);
          estimatedTokens = messageTokens;
        }
        logger.warn('SDK', 'Grok context truncated', {
          originalMessages: history.length,
          keptMessages: kept.length,
          estimatedTokens,
        });
        break;
      }
      kept.unshift(message);
      estimatedTokens += messageTokens;
    }

    return kept;
  }
}

function normalizeReasoningEffort(value: string): string {
  return GROK_REASONING_EFFORTS.has(value)
    ? value
    : DEFAULT_GROK_REASONING_EFFORT;
}

function clipPromptContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.floor(maxChars * 0.25);
  const elided = content.length - head - tail;
  return `${content.slice(0, head)}\n... <elided chars="${elided}" reason="grok_prompt_budget" /> ...\n${content.slice(-tail)}`;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Private GROK_HOME so observer/summary CLI sessions do not appear under the
 * user's real ~/.grok session list. Reuses auth via symlink when possible.
 */
export function ensureObserverGrokHome(): string {
  const home = OBSERVER_GROK_HOME;
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });

  const realGrok = join(homedir(), '.grok');
  // Files the CLI needs for membership login / model cache.
  for (const name of ['auth.json', 'models_cache.json', 'config.toml', 'agent_id']) {
    const target = join(home, name);
    const source = join(realGrok, name);
    if (existsSync(target) || !existsSync(source)) continue;
    try {
      symlinkSync(source, target);
    } catch {
      try {
        writeFileSync(target, readFileSync(source));
      } catch {
        // best-effort
      }
    }
  }

  // Prefer a private binary path lookup still via PATH; only home is isolated.
  return home;
}

async function acquireGrokSlot(maxConcurrent: number, signal?: AbortSignal): Promise<() => void> {
  const release = () => {
    activeGrokExecs = Math.max(0, activeGrokExecs - 1);
    const next = grokSlotWaiters.shift();
    if (next) next();
  };

  if (activeGrokExecs < maxConcurrent) {
    activeGrokExecs += 1;
    return release;
  }

  if (signal?.aborted) {
    throw createAbortError('Grok slot wait aborted before queueing');
  }

  logger.info('SDK', `Grok pool limit reached (${activeGrokExecs}/${maxConcurrent}), waiting for slot`);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const idx = grokSlotWaiters.indexOf(onSlot);
      if (idx >= 0) grokSlotWaiters.splice(idx, 1);
      reject(createAbortError('Grok slot wait aborted'));
    };
    const onSlot = () => {
      if (settled) return;
      if (activeGrokExecs < maxConcurrent) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        activeGrokExecs += 1;
        resolve();
        return;
      }
      grokSlotWaiters.push(onSlot);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    grokSlotWaiters.push(onSlot);
  });

  return release;
}

function killChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to terminating the direct child.
  }

  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

/** Strip model noise and keep valid observer XML roots when present. */
export function sanitizeGrokOutput(raw: string): string {
  let text = raw
    .replace(/<\|eos\|>/g, '')
    .replace(/<\|end\|>/g, '')
    .trim();

  if (!text) return '';

  const observations = Array.from(text.matchAll(/<observation\b[\s\S]*?<\/observation>/gi), match => match[0].trim());
  if (observations.length > 0) return observations.join('\n');

  const summary = /<summary\b[\s\S]*?<\/summary>/i.exec(text);
  if (summary) return summary[0].trim();

  const skip = /<skip_summary\b[^>]*\/>/i.exec(text);
  if (skip) return skip[0].trim();

  return text;
}

/**
 * Grok often puts observation-shaped fields inside <summary> (or vice versa).
 * Normalize to the protocol the claude-mem parser accepts.
 */
export function normalizeGrokObserverXml(raw: string): string {
  const text = raw.trim();
  if (!text) return '';

  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  if (summaryMatch) {
    const body = summaryMatch[1];
    const hasSummaryFields = /<(request|investigated|learned|completed|next_steps)\b/i.test(body);
    if (hasSummaryFields) {
      return `<summary>${body}</summary>`;
    }

    // Grok often emits observation-shaped fields inside <summary>. Prefer
    // salvaging into the real summary schema so summarize jobs still land.
    if (/<(type|title|narrative|facts|subtitle|concepts|topic|content)\b/i.test(body)) {
      const request = extractTag(body, 'request')
        || extractTag(body, 'title')
        || extractTag(body, 'topic')
        || 'session activity';
      const investigated = extractTag(body, 'investigated')
        || extractTag(body, 'facts')
        || extractTag(body, 'subtitle')
        || '';
      const learned = extractTag(body, 'learned')
        || extractTag(body, 'narrative')
        || extractTag(body, 'content')
        || '';
      const completed = extractTag(body, 'completed') || '';
      const nextSteps = extractTag(body, 'next_steps') || '';
      const notes = extractTag(body, 'notes') || extractTag(body, 'concepts') || '';
      return [
        '<summary>',
        `  <request>${escapeXml(request)}</request>`,
        `  <investigated>${escapeXml(investigated)}</investigated>`,
        `  <learned>${escapeXml(learned)}</learned>`,
        `  <completed>${escapeXml(completed)}</completed>`,
        `  <next_steps>${escapeXml(nextSteps)}</next_steps>`,
        `  <notes>${escapeXml(notes)}</notes>`,
        '</summary>',
      ].join('\n');
    }
  }

  const observations = Array.from(text.matchAll(/<observation\b[\s\S]*?<\/observation>/gi), match => match[0].trim());
  if (observations.length > 0) return observations.join('\n');

  return text;
}

function extractTag(body: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(body);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function looksLikeObserverXml(text: string): boolean {
  return /<(observation|summary|skip_summary)\b/i.test(text);
}

function isGrokLimitProse(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('session limit')
    || lower.includes('usage limit')
    || lower.includes("you've hit your")
    || lower.includes('hit your session')
    || lower.includes('hit your usage')
  );
}

function classifyGrokExecError(code: number | null, stderr: string, stdout: string): Error {
  const diagnostic = `${stderr}\n${stdout}`.trim().slice(-1_000);
  const cause = new Error(
    `grok exec failed with code ${code ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : ''}`,
  );
  const lower = diagnostic.toLowerCase();

  if (
    lower.includes('usage limit')
    || lower.includes('session limit')
    || lower.includes('hit your')
    || lower.includes('quota')
    || lower.includes('rate limit exceeded')
    || lower.includes('insufficient')
  ) {
    return new ClassifiedProviderError('Grok quota exhausted', {
      kind: 'quota_exhausted',
      cause,
    });
  }
  if (
    lower.includes('rate limit')
    || lower.includes('too many requests')
    || lower.includes('overloaded')
  ) {
    return new ClassifiedProviderError('Grok rate limited', {
      kind: 'rate_limit',
      cause,
    });
  }
  // max-turns with no XML is a soft failure for this call, not a global rate limit
  if (lower.includes('max turns reached')) {
    return new Error(`Grok max turns with no protocol XML: ${diagnostic.slice(0, 200)}`);
  }
  if (
    lower.includes('not logged in')
    || lower.includes('authentication')
    || lower.includes('unauthorized')
    || lower.includes('sign in')
  ) {
    return new ClassifiedProviderError('Grok authentication is invalid', {
      kind: 'auth_invalid',
      cause,
    });
  }

  return cause;
}

function runGrokExec(args: string[], signal?: AbortSignal, grokHome?: string): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError('Grok exec aborted before start'));
  }

  return new Promise((resolve, reject) => {
    const invocation = resolveGrokSpawnInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...sanitizeEnv(process.env),
        CLAUDE_MEM_SUPPRESS_HOOKS: '1',
        GROK_NO_MEMORY: '1',
        ...(grokHome ? { GROK_HOME: grokHome } : {}),
      },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError: Error | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (error?: Error, content?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve((content ?? '').trim());
    };

    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      killChildTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), 5_000);
      forceKillTimer.unref?.();
    };

    const onAbort = () => terminate(createAbortError('Grok exec aborted'));
    const timeoutTimer = setTimeout(() => {
      terminate(createAbortError(`Grok exec timed out after ${GROK_EXEC_TIMEOUT_MS}ms`));
    }, GROK_EXEC_TIMEOUT_MS);
    timeoutTimer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.on('error', (error) => {
      settle(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('close', (code) => {
      if (terminationError) {
        settle(terminationError);
        return;
      }
      const content = sanitizeGrokOutput(stdout);
      if (content && (looksLikeObserverXml(content) || isGrokLimitProse(content))) {
        settle(undefined, content);
        return;
      }
      if (code === 0) {
        settle(undefined, content);
        return;
      }
      settle(classifyGrokExecError(code, stderr, stdout));
    });
  });
}

export function isGrokSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'grok';
}

export function isGrokQuotaCooldownActive(now = Date.now()): boolean {
  return now < grokQuotaBlockedUntil;
}

export function getGrokQuotaCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, grokQuotaBlockedUntil - now);
}

export function resetGrokQuotaCooldownForTesting(): void {
  grokQuotaBlockedUntil = 0;
  activeGrokExecs = 0;
  grokSlotWaiters.length = 0;
}

export function buildGrokExecArgs(
  model: string,
  promptFile: string,
  cwd: string,
  reasoningEffort = DEFAULT_GROK_REASONING_EFFORT,
): string[] {
  const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
  return [
    '--prompt-file', promptFile,
    '--output-format', 'plain',
    '--no-memory',
    '--no-subagents',
    '--max-turns', '5',
    '--tools', '',
    '--verbatim',
    '--disable-web-search',
    '--no-auto-update',
    '--cwd', cwd,
    '-m', model || DEFAULT_GROK_MODEL,
    '--reasoning-effort', normalizedEffort,
  ];
}
