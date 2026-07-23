import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { resolveCodexSpawnInvocation } from '../integrations/CodexCliInstaller.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError, isClassified } from './provider-errors.js';

interface CodexConfig {
  apiKey: string;
  model: string;
  reasoningEffort: string;
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

const CODEX_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const MAX_CONTEXT_MESSAGES = 12;
const MAX_ESTIMATED_TOKENS = 60_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CODEX_EXEC_TIMEOUT_MS = 240_000;
const CODEX_QUOTA_RETRY_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_CONCURRENT_CODEX = 2;

let codexQuotaBlockedUntil = 0;
let activeCodexExecs = 0;
const codexSlotWaiters: Array<() => void> = [];

export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected shouldRunInitQuery(): boolean {
    return false;
  }

  protected selectHistoryForQuery(history: ConversationMessage[]): ConversationMessage[] {
    if (history.length <= 2) return history;
    const lastUser = [...history].reverse().find(message => message.role === 'user');
    return lastUser ? [history[0], lastUser] : [history[0]];
  }

  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      apiKey: 'codex-cli',
      model: settings.CLAUDE_MEM_CODEX_MODEL || DEFAULT_CODEX_MODEL,
      reasoningEffort: normalizeReasoningEffort(settings.CLAUDE_MEM_CODEX_REASONING_EFFORT),
    };
  }

  protected override getSummaryConfig(config: CodexConfig): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_SUMMARY_PROVIDER !== 'codex') return config;

    return {
      ...config,
      model: settings.CLAUDE_MEM_SUMMARY_MODEL || config.model,
      reasoningEffort: normalizeReasoningEffort(settings.CLAUDE_MEM_SUMMARY_EFFORT),
    };
  }

  protected missingApiKeyError(): Error {
    return new Error('Codex CLI is not available. Install Codex and sign in before selecting the Codex provider.');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(_result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return null;
  }

  protected async query(
    history: ConversationMessage[],
    config: CodexConfig,
    session?: ActiveSession,
  ): Promise<ProviderQueryResult> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = Math.max(
      1,
      parseInt(settings.CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || DEFAULT_MAX_CONCURRENT_CODEX,
    );
    const releaseSlot = await acquireCodexSlot(maxConcurrent, session?.abortController.signal);
    const truncated = this.truncateHistory(history);
    const prompt = [
      'You are the claude-mem observer. Return only valid claude-mem XML.',
      'Do not use Markdown or include prose outside the XML response.',
      '',
      ...truncated.map((message, index) => (
        `--- ${index + 1} ${message.role} ---\n${message.content}`
      )),
    ].join('\n');

    const workDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-'));
    const outputPath = join(workDir, 'last-message.txt');
    const args = buildCodexExecArgs(
      config.model,
      outputPath,
      workDir,
      config.reasoningEffort,
    );

    try {
      logger.info('SDK', 'Querying Codex', {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        turns: truncated.length,
      });
      try {
        await runCodexExec(args, prompt, session?.abortController.signal);
        codexQuotaBlockedUntil = 0;
      } catch (error) {
        if (
          session
          && isClassified(error)
          && (error.kind === 'quota_exhausted' || error.kind === 'rate_limit')
        ) {
          codexQuotaBlockedUntil = Date.now() + CODEX_QUOTA_RETRY_COOLDOWN_MS;
          await this.sessionManager.resetProcessingToPending(session.sessionDbId);
          session.abortReason = `quota:codex_${error.kind}`;
          session.abortController.abort();
        }
        throw error;
      }
      const content = existsSync(outputPath)
        ? readFileSync(outputPath, 'utf-8').trim()
        : '';
      return { content: normalizeCodexObserverOutput(content), servedModel: config.model };
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
        logger.warn('SDK', 'Codex context truncated', {
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

async function acquireCodexSlot(maxConcurrent: number, signal?: AbortSignal): Promise<() => void> {
  const release = () => {
    activeCodexExecs = Math.max(0, activeCodexExecs - 1);
    codexSlotWaiters.shift()?.();
  };

  if (activeCodexExecs < maxConcurrent) {
    activeCodexExecs += 1;
    return release;
  }
  if (signal?.aborted) throw createAbortError('Codex slot wait aborted before queueing');

  logger.info('SDK', `Codex pool limit reached (${activeCodexExecs}/${maxConcurrent}), waiting for slot`);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = codexSlotWaiters.indexOf(onSlot);
      if (index >= 0) codexSlotWaiters.splice(index, 1);
      reject(createAbortError('Codex slot wait aborted'));
    };
    const onSlot = () => {
      if (settled) return;
      if (activeCodexExecs < maxConcurrent) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        activeCodexExecs += 1;
        resolve();
        return;
      }
      codexSlotWaiters.push(onSlot);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    codexSlotWaiters.push(onSlot);
  });

  return release;
}

export function normalizeCodexObserverOutput(content: string): string {
  return /^<observations\s*\/?\s*>\s*(?:<\/observations\s*>)?$/i.test(content.trim())
    ? ''
    : content;
}

function normalizeReasoningEffort(value: string): string {
  return CODEX_REASONING_EFFORTS.has(value)
    ? value
    : DEFAULT_CODEX_REASONING_EFFORT;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
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

function classifyCodexExecError(code: number | null, stderr: string): Error {
  const diagnostic = stderr.trim().slice(-1_000);
  const cause = new Error(
    `codex exec failed with code ${code ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : ''}`,
  );
  const lower = diagnostic.toLowerCase();

  if (lower.includes('usage limit') || lower.includes('quota')) {
    return new ClassifiedProviderError('Codex quota exhausted', {
      kind: 'quota_exhausted',
      cause,
    });
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return new ClassifiedProviderError('Codex rate limited', {
      kind: 'rate_limit',
      cause,
    });
  }
  if (lower.includes('not logged in') || lower.includes('authentication')) {
    return new ClassifiedProviderError('Codex authentication is invalid', {
      kind: 'auth_invalid',
      cause,
    });
  }

  return cause;
}

function runCodexExec(args: string[], stdin: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError('Codex exec aborted before start'));
  }

  return new Promise((resolve, reject) => {
    const invocation = resolveCodexSpawnInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...sanitizeEnv(process.env),
        CLAUDE_MEM_SUPPRESS_HOOKS: '1',
      },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stderr = '';
    let settled = false;
    let terminationError: Error | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      killChildTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), 5_000);
      forceKillTimer.unref?.();
    };

    const onAbort = () => terminate(createAbortError('Codex exec aborted'));
    const timeoutTimer = setTimeout(() => {
      terminate(createAbortError(`Codex exec timed out after ${CODEX_EXEC_TIMEOUT_MS}ms`));
    }, CODEX_EXEC_TIMEOUT_MS);
    timeoutTimer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
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
      } else if (code === 0) {
        settle();
      } else {
        settle(classifyCodexExecError(code, stderr));
      }
    });
    child.stdin?.on('error', (error) => {
      if (!terminationError && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
        terminate(error);
      }
    });
    child.stdin?.end(stdin);
  });
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}

export function isCodexQuotaCooldownActive(now = Date.now()): boolean {
  return now < codexQuotaBlockedUntil;
}

export function getCodexQuotaCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, codexQuotaBlockedUntil - now);
}

export function resetCodexQuotaCooldownForTesting(): void {
  codexQuotaBlockedUntil = 0;
}

export function buildCodexExecArgs(
  model: string,
  outputPath: string,
  cwd: string,
  reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
): string[] {
  const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
  return [
    '--ask-for-approval', 'never',
    '-c', `model_reasoning_effort="${normalizedEffort}"`,
    'exec',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--color', 'never',
    '--output-last-message', outputPath,
    '-C', cwd,
    '-m', model || DEFAULT_CODEX_MODEL,
    '-',
  ];
}
