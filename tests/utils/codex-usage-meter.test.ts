import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneCodexUsageFiles, recordCodexUsage } from '../../src/utils/codex-usage-meter.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempUsageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-usage-'));
  tempDirs.push(dir);
  return dir;
}

describe('codex usage meter', () => {
  it('writes only exact usage metadata to a daily JSONL spool', () => {
    const usageDir = tempUsageDir();
    const timestamp = new Date('2026-07-27T08:58:18.000Z');

    expect(recordCodexUsage({
      eventId: 'thread-1',
      model: 'gpt-5.6-luna',
      project: '/project',
      sessionId: 'session-1',
      timestamp,
      usage: {
        inputTokens: 22_738,
        cachedInputTokens: 6_912,
        cacheWriteInputTokens: 0,
        outputTokens: 46,
        reasoningOutputTokens: 39,
      },
    }, usageDir)).toBe(true);

    const line = readFileSync(join(usageDir, 'codex-usage-2026-07-27.jsonl'), 'utf8');
    expect(JSON.parse(line)).toEqual({
      type: 'claude_mem.codex_usage',
      schema_version: 1,
      timestamp: '2026-07-27T08:58:18.000Z',
      event_id: 'thread-1',
      model: 'gpt-5.6-luna',
      project: '/project',
      session_id: 'session-1',
      usage: {
        input_tokens: 22_738,
        cached_input_tokens: 6_912,
        cache_write_input_tokens: 0,
        output_tokens: 46,
        reasoning_output_tokens: 39,
      },
    });
  });

  it('retains only the recent daily usage files', () => {
    const usageDir = tempUsageDir();
    writeFileSync(join(usageDir, 'codex-usage-2026-01-01.jsonl'), '{}\n');
    writeFileSync(join(usageDir, 'codex-usage-2026-07-27.jsonl'), '{}\n');

    expect(pruneCodexUsageFiles(usageDir, Date.parse('2026-07-27T12:00:00Z'), 90)).toBe(1);
    expect(existsSync(join(usageDir, 'codex-usage-2026-01-01.jsonl'))).toBe(false);
    expect(existsSync(join(usageDir, 'codex-usage-2026-07-27.jsonl'))).toBe(true);
  });
});
