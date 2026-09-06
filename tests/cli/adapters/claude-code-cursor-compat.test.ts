import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

describe('claudeCodeAdapter Cursor compatibility ghosts', () => {
  it('still accepts a real Claude Code payload', () => {
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'claude-123',
      cwd: '/tmp/project',
      prompt: 'fix the bug',
    });
    expect(input.sessionId).toBe('claude-123');
    expect(input.cwd).toBe('/tmp/project');
  });

  it('rejects Cursor native hook fields replayed as claude-code', () => {
    expect(() => claudeCodeAdapter.normalizeInput({
      conversation_id: 'b4e86952-01a0-4386-8c32-3367746aefed',
      workspace_roots: ['/tmp/project'],
      cwd: '/tmp/project',
    })).toThrow(AdapterRejectedInput);

    try {
      claudeCodeAdapter.normalizeInput({
        generation_id: 'gen-1',
        cwd: '/tmp/project',
      });
      throw new Error('expected reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterRejectedInput);
      expect((error as AdapterRejectedInput).reason).toBe('cursor_compat_duplicate');
    }
  });
});
