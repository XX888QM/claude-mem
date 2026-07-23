import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import {
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_REASONING_EFFORT,
  GrokProvider,
  buildGrokExecArgs,
  isGrokQuotaCooldownActive,
  resetGrokQuotaCooldownForTesting,
  normalizeGrokObserverXml,
  sanitizeGrokOutput,
} from '../../src/services/worker/GrokProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const originalPath = process.env.PATH;
const originalGrokPath = process.env.GROK_PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGrokPath === undefined) delete process.env.GROK_PATH;
  else process.env.GROK_PATH = originalGrokPath;
  resetGrokQuotaCooldownForTesting();
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 77,
    contentSessionId: 'content-77',
    memorySessionId: 'grok-content-77',
    project: 'project',
    platformSource: 'grok',
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
    currentProvider: 'grok',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  };
}

describe('GrokProvider', () => {
  it('runs grok-4.5 headless with no tools and membership CLI flags', () => {
    expect(DEFAULT_GROK_MODEL).toBe('grok-4.5');
    expect(DEFAULT_GROK_REASONING_EFFORT).toBe('medium');
    expect(buildGrokExecArgs(
      DEFAULT_GROK_MODEL,
      '/tmp/prompt.txt',
      '/tmp/grok-work',
      DEFAULT_GROK_REASONING_EFFORT,
    )).toEqual([
      '--prompt-file', '/tmp/prompt.txt',
      '--output-format', 'plain',
      '--no-memory',
      '--no-subagents',
      '--max-turns', '5',
      '--tools', '',
      '--verbatim',
      '--disable-web-search',
      '--no-auto-update',
      '--cwd', '/tmp/grok-work',
      '-m', 'grok-4.5',
      '--reasoning-effort', 'medium',
    ]);
  });

  it('sanitizes eos tokens and extracts observer XML', () => {
    expect(sanitizeGrokOutput('<|eos|>')).toBe('');
    expect(sanitizeGrokOutput('noise\n<summary><request>x</request></summary>\ntrailer'))
      .toBe('<summary><request>x</request></summary>');
    expect(sanitizeGrokOutput('<?xml version="1.0"?><claude-mem><observation><title>t</title></observation></claude-mem>'))
      .toBe('<observation><title>t</title></observation>');
  });

  it('keeps every observation in a batched Grok response', () => {
    const raw = '<observation><title>one</title></observation><observation><title>two</title></observation>';
    expect(sanitizeGrokOutput(raw)).toBe(raw.replace('</observation><observation>', '</observation>\n<observation>'));
    expect(normalizeGrokObserverXml(raw)).toBe(raw.replace('</observation><observation>', '</observation>\n<observation>'));
  });

  it('salvages observation-shaped summary into protocol summary fields', () => {
    const raw = `<summary>
  <type>discovery</type>
  <title>Empty primary session</title>
  <subtitle>no tools</subtitle>
  <facts>["a"]</facts>
  <narrative>hello</narrative>
</summary>`;
    const out = normalizeGrokObserverXml(raw);
    expect(out).toContain('<summary>');
    expect(out).toContain('<request>Empty primary session</request>');
    expect(out).toContain('<learned>hello</learned>');
    expect(out).toContain('<investigated>["a"]</investigated>');
  });

  it('keeps proper summary fields intact', () => {
    const raw = `<summary>
  <request>do x</request>
  <investigated>y</investigated>
  <learned>z</learned>
  <completed>done</completed>
  <next_steps>none</next_steps>
  <notes></notes>
</summary>`;
    expect(normalizeGrokObserverXml(raw)).toContain('<request>do x</request>');
  });

  it('falls back to medium when a stored reasoning value is unsupported', () => {
    const args = buildGrokExecArgs(
      DEFAULT_GROK_MODEL,
      '/tmp/prompt.txt',
      '/tmp/grok-work',
      'unsupported',
    );
    expect(args).toContain('--reasoning-effort');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('medium');
  });

  it('keeps the Grok model separate from the Claude model setting', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_GROK_MODEL).toBe('grok-4.5');
    expect(defaults.CLAUDE_MEM_GROK_REASONING_EFFORT).toBe('medium');
  });

  it('uses summary-only model and effort without changing observation config', () => {
    process.env.CLAUDE_MEM_SUMMARY_PROVIDER = 'grok';
    process.env.CLAUDE_MEM_SUMMARY_MODEL = 'grok-4.5';
    process.env.CLAUDE_MEM_SUMMARY_EFFORT = 'high';
    try {
      class TestGrokProvider extends GrokProvider {
        summaryConfig(config: { apiKey: string; model: string; reasoningEffort: string }) {
          return this.getSummaryConfig(config);
        }
      }

      const observationConfig = {
        apiKey: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'low',
      };
      const provider = new TestGrokProvider({} as any, {} as any);

      expect(provider.summaryConfig(observationConfig)).toEqual({
        apiKey: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      expect(observationConfig.reasoningEffort).toBe('low');
    } finally {
      delete process.env.CLAUDE_MEM_SUMMARY_PROVIDER;
      delete process.env.CLAUDE_MEM_SUMMARY_MODEL;
      delete process.env.CLAUDE_MEM_SUMMARY_EFFORT;
    }
  });

  it('preserves claimed work when the Grok quota is exhausted', async () => {
    if (process.platform === 'win32') return;

    const binDir = mkdtempSync(join(tmpdir(), 'claude-mem-grok-bin-'));
    const grokPath = join(binDir, 'grok');
    writeFileSync(grokPath, '#!/bin/sh\necho "You have hit your usage limit" >&2\nexit 1\n');
    chmodSync(grokPath, 0o755);
    process.env.GROK_PATH = grokPath;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    let resetCalls = 0;
    class TestGrokProvider extends GrokProvider {
      runQuery(history: ConversationMessage[], session: ActiveSession) {
        return this.query(history, {
          apiKey: 'grok-cli',
          model: DEFAULT_GROK_MODEL,
          reasoningEffort: DEFAULT_GROK_REASONING_EFFORT,
        }, session);
      }
    }

    const provider = new TestGrokProvider({} as any, {
      resetProcessingToPending: async () => { resetCalls += 1; return 1; },
    } as any);
    const session = makeSession();

    try {
      await expect(provider.runQuery([
        { role: 'user', content: '<observation>test</observation>' },
      ], session)).rejects.toThrow('Grok quota exhausted');
      expect(resetCalls).toBe(1);
      expect(session.abortReason).toBe('quota:grok_quota_exhausted');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(isGrokQuotaCooldownActive()).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
