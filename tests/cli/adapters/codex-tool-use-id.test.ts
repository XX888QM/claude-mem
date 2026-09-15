import { expect, test } from 'bun:test';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';

test('Codex forwards a provided tool identity without inventing one', () => {
  const input = { session_id: 'test-session', cwd: process.cwd(), tool_name: 'Read' };
  expect(codexAdapter.normalizeInput({ ...input, tool_use_id: 'use-1' }).toolUseId).toBe('use-1');
  expect(codexAdapter.normalizeInput({ ...input, tool_call_id: 'call-1' }).toolUseId).toBe('call-1');
  expect(codexAdapter.normalizeInput({ ...input, tool_use_id: 12 }).toolUseId).toBeUndefined();
  expect(codexAdapter.normalizeInput(input).toolUseId).toBeUndefined();
});
