import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import {
  CodexProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  buildCodexExecArgs,
  isCodexQuotaCooldownActive,
  normalizeCodexObserverOutput,
  resetCodexQuotaCooldownForTesting,
} from '../../src/services/worker/CodexProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  resetCodexQuotaCooldownForTesting();
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 56,
    contentSessionId: 'content-56',
    memorySessionId: 'codex-content-56',
    project: 'project',
    platformSource: 'codex',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [1],
    conversationHistory: [],
    currentProvider: 'codex',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  };
}

describe('CodexProvider', () => {
  it('runs GPT-5.6 Luna with medium reasoning in an isolated read-only exec', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-luna');
    expect(DEFAULT_CODEX_REASONING_EFFORT).toBe('medium');
    expect(buildCodexExecArgs(
      DEFAULT_CODEX_MODEL,
      '/tmp/codex-output.txt',
      '/tmp/codex-work',
      DEFAULT_CODEX_REASONING_EFFORT,
    )).toEqual([
      '--ask-for-approval', 'never',
      '-c', 'model_reasoning_effort="medium"',
      'exec',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--color', 'never',
      '--output-last-message', '/tmp/codex-output.txt',
      '-C', '/tmp/codex-work',
      '-m', 'gpt-5.6-luna',
      '-',
    ]);
  });

  it('rejects unsupported max effort and falls back to medium', () => {
    const args = buildCodexExecArgs(
      DEFAULT_CODEX_MODEL,
      '/tmp/codex-output.txt',
      '/tmp/codex-work',
      'max',
    );

    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it('keeps the Codex model separate from the Claude model setting', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();

    expect(defaults.CLAUDE_MEM_CODEX_MODEL).toBe('gpt-5.6-luna');
    expect(defaults.CLAUDE_MEM_CODEX_REASONING_EFFORT).toBe('medium');
  });

  it('skips the wasteful init call but keeps init protocol context for each task', () => {
    class TestCodexProvider extends CodexProvider {
      shouldInit() { return this.shouldRunInitQuery(); }
      select(history: ConversationMessage[]) { return this.selectHistoryForQuery(history); }
    }

    const provider = new TestCodexProvider({} as any, {} as any);
    const history: ConversationMessage[] = [
      { role: 'user', content: 'protocol skeleton' },
      { role: 'assistant', content: 'old response' },
      { role: 'user', content: 'current observation' },
    ];

    expect(provider.shouldInit()).toBe(false);
    expect(provider.select(history)).toEqual([history[0], history[2]]);
  });

  it('treats an empty observations container as an intentional skip', () => {
    expect(normalizeCodexObserverOutput('<observations/>')).toBe('');
    expect(normalizeCodexObserverOutput('<observations>\n</observations>')).toBe('');
    expect(normalizeCodexObserverOutput('<observation><type>change</type></observation>'))
      .toContain('<observation>');
  });

  it('honors CLAUDE_MEM_MAX_CONCURRENT_AGENTS for Codex execs', async () => {
    if (process.platform === 'win32') return;

    const binDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-pool-'));
    const codexPath = join(binDir, 'codex');
    const lockDir = join(binDir, 'lock');
    const overlapPath = join(binDir, 'overlap');
    writeFileSync(codexPath, `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
if ! mkdir "${lockDir}" 2>/dev/null; then touch "${overlapPath}"; fi
sleep 0.2
rmdir "${lockDir}" 2>/dev/null || true
: > "$out"
exit 0
`);
    chmodSync(codexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS = '1';

    class TestCodexProvider extends CodexProvider {
      runQuery(session: ActiveSession) {
        return this.query([{ role: 'user', content: 'task' }], {
          apiKey: 'codex-cli',
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        }, session);
      }
    }

    const provider = new TestCodexProvider({} as any, {} as any);
    try {
      await Promise.all([provider.runQuery(makeSession()), provider.runQuery(makeSession())]);
      expect(existsSync(overlapPath)).toBe(false);
    } finally {
      delete process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('preserves claimed work when the Codex quota is exhausted', async () => {
    if (process.platform === 'win32') return;

    const binDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-bin-'));
    const codexPath = join(binDir, 'codex');
    writeFileSync(codexPath, '#!/bin/sh\necho "You have hit your usage limit" >&2\nexit 1\n');
    chmodSync(codexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    let resetCalls = 0;
    class TestCodexProvider extends CodexProvider {
      runQuery(history: ConversationMessage[], session: ActiveSession) {
        return this.query(history, {
          apiKey: 'codex-cli',
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        }, session);
      }
    }

    const provider = new TestCodexProvider({} as any, {
      resetProcessingToPending: async () => { resetCalls += 1; return 1; },
    } as any);
    const session = makeSession();

    try {
      await expect(provider.runQuery([
        { role: 'user', content: '<observation>test</observation>' },
      ], session)).rejects.toThrow('Codex quota exhausted');
      expect(resetCalls).toBe(1);
      expect(session.abortReason).toBe('quota:codex_quota_exhausted');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(isCodexQuotaCooldownActive()).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
