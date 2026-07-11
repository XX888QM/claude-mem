import { afterEach, describe, expect, it } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';

const previousProvider = process.env.CLAUDE_MEM_PROVIDER;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 78,
    contentSessionId: 'content-78',
    memorySessionId: null,
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
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  };
}

afterEach(() => {
  if (previousProvider === undefined) {
    delete process.env.CLAUDE_MEM_PROVIDER;
  } else {
    process.env.CLAUDE_MEM_PROVIDER = previousProvider;
  }
});

describe('SessionRoutes Grok provider', () => {
  it('uses Grok without automatically falling back to Claude or Codex', async () => {
    process.env.CLAUDE_MEM_PROVIDER = 'grok';
    const session = makeSession();
    const starts = { claude: 0, gemini: 0, openrouter: 0, codex: 0, grok: 0 };
    const provider = (name: keyof typeof starts) => ({
      startSession: async () => { starts[name] += 1; },
    });
    const sessionManager = {
      getSession: () => session,
      getMessageBuffer: () => ({
        getPendingCount: () => 1,
        peekTypes: () => [],
      }),
      removeSessionImmediate: () => {},
    };

    const routes = new (SessionRoutes as any)(
      sessionManager,
      {},
      provider('claude'),
      provider('gemini'),
      provider('openrouter'),
      provider('codex'),
      provider('grok'),
      {},
      {},
      { finalizeSession: async () => {} },
    ) as SessionRoutes;

    await routes.ensureGeneratorRunning(session.sessionDbId, 'summarize');
    if (session.generatorPromise) await session.generatorPromise;

    expect(starts).toEqual({ claude: 0, gemini: 0, openrouter: 0, codex: 0, grok: 1 });
  });
});
