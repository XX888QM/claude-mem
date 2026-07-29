import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldRuntimeLogs } from '../../src/utils/logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runtime log retention', () => {
  it('removes only dated claude-mem logs older than the retention window', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'claude-mem-runtime-logs-'));
    tempDirs.push(logsDir);
    writeFileSync(join(logsDir, 'claude-mem-2026-07-01.log'), 'old\n');
    writeFileSync(join(logsDir, 'claude-mem-2026-07-27.log'), 'new\n');
    writeFileSync(join(logsDir, 'unrelated.log'), 'keep\n');

    expect(pruneOldRuntimeLogs(logsDir, Date.parse('2026-07-27T12:00:00Z'), 14)).toBe(1);
    expect(existsSync(join(logsDir, 'claude-mem-2026-07-01.log'))).toBe(false);
    expect(existsSync(join(logsDir, 'claude-mem-2026-07-27.log'))).toBe(true);
    expect(existsSync(join(logsDir, 'unrelated.log'))).toBe(true);
  });
});
