import { afterEach, describe, expect, it } from 'bun:test';
import { hookCommand } from '../../src/cli/hook-command.js';
import { resetHookIoState } from '../../src/shared/hook-io.js';

const previousSuppressHooks = process.env.CLAUDE_MEM_SUPPRESS_HOOKS;

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.join(' ')); };
  return { chunks, restore: () => { console.log = original; } };
}

afterEach(() => {
  if (previousSuppressHooks === undefined) {
    delete process.env.CLAUDE_MEM_SUPPRESS_HOOKS;
  } else {
    process.env.CLAUDE_MEM_SUPPRESS_HOOKS = previousSuppressHooks;
  }
  resetHookIoState();
});

describe('hookCommand Codex direct suppression', () => {
  it('skips hook processing without reading stdin during internal Codex exec', async () => {
    process.env.CLAUDE_MEM_SUPPRESS_HOOKS = '1';
    const out = captureStdout();

    try {
      const code = await hookCommand('codex', 'context', { skipExit: true });
      expect(code).toBe(0);
      expect(out.chunks).toHaveLength(1);
      expect(JSON.parse(out.chunks[0])).toEqual({ continue: true });
    } finally {
      out.restore();
    }
  });
});
