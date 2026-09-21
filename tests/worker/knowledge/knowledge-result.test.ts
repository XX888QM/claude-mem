import { afterAll, expect, mock, test } from 'bun:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import * as env from '../../../src/shared/EnvManager.js';
import * as executable from '../../../src/shared/find-claude-executable.js';

const originals = [{ ...sdk }, { ...env }, { ...executable }];
let messages: any[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...originals[0], query: async function* () { yield* messages; } }));
mock.module('../../../src/shared/EnvManager.js', () => ({ ...originals[1], buildIsolatedEnvWithFreshOAuth: async () => ({}) }));
mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...originals[2], findClaudeExecutable: () => '/unused/claude' }));
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => originals[0]);
  mock.module('../../../src/shared/EnvManager.js', () => originals[1]);
  mock.module('../../../src/shared/find-claude-executable.js', () => originals[2]);
});
const { KnowledgeAgent } = await import('../../../src/services/worker/knowledge/KnowledgeAgent.js');

test('failed SDK results cannot save a session or become a knowledge answer', async () => {
  const previous = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = 'false';
  try {
  const write = mock(() => {});
  const agent = new KnowledgeAgent({ write } as any);
  const corpus = { name: 'test', system_prompt: '', observations: [], session_id: 'original',
    stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' } } } as any;
  messages = [
    { type: 'assistant', session_id: 'failed', message: { content: [{ type: 'text', text: 'Not logged in' }] } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'failed' },
  ];
  await expect(agent.prime(corpus)).rejects.toThrow('Knowledge priming failed');
  await expect(agent.query(corpus, 'question')).rejects.toThrow('Knowledge query failed');
  expect(corpus.session_id).toBe('original');
  expect(write).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
    else process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = previous;
  }
});

test('disallowed Claude quota never starts a Claude session', async () => {
  process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = 'true';
  const write = mock(() => {});
  const agent = new KnowledgeAgent({ write } as any);
  const corpus = { name: 'test', system_prompt: '', observations: [], session_id: null,
    stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' } } } as any;
  await expect(agent.prime(corpus)).rejects.toThrow('Claude subscription quota is disabled');
  expect(write).not.toHaveBeenCalled();
  delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
});
