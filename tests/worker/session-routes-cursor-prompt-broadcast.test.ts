import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';

describe('SessionRoutes Cursor prompt broadcast', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function makeRoutes() {
    const broadcasts: Array<Record<string, unknown>> = [];
    const chromaSyncs: number[] = [];
    let initializeCalls = 0;
    let generatorStarts = 0;

    const sessionManager = {
      getSession: () => undefined,
      initializeSession: (sessionDbId: number, _prompt: string, _promptNumber: number, project: string) => {
        initializeCalls += 1;
        return {
          sessionDbId,
          contentSessionId: 'unused',
          project,
        };
      },
    };

    const dbManager = {
      getSessionStore: () => store,
      getCloudSync: () => ({ notify: () => {} }),
      getChromaSync: () => ({
        syncUserPrompt: async (id: number) => {
          chromaSyncs.push(id);
        },
      }),
    };

    const eventBroadcaster = {
      broadcastNewPrompt: (prompt: Record<string, unknown>) => {
        broadcasts.push(prompt);
      },
      broadcastSessionStarted: () => {},
    };

    const routes = new (SessionRoutes as any)(
      sessionManager,
      dbManager,
      {},
      {},
      {},
      {},
      {},
      eventBroadcaster,
      {},
      { finalizeSession: async () => {} },
    ) as SessionRoutes;

    routes.ensureGeneratorRunning = async () => {
      generatorStarts += 1;
    };

    return {
      routes,
      broadcasts,
      chromaSyncs,
      getInitializeCalls: () => initializeCalls,
      getGeneratorStarts: () => generatorStarts,
    };
  }

  function invokeInit(
    routes: SessionRoutes,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const req = {
        body,
        query: {},
        path: '/api/sessions/init',
        get: () => undefined,
      } as unknown as Request;
      const res = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: Record<string, unknown>) {
          resolve(payload);
          return this;
        },
      } as unknown as Response;

      try {
        (routes as any).handleSessionInitByClaudeId(req, res);
      } catch (error) {
        reject(error);
      }

      setTimeout(() => reject(new Error('session-init timed out')), 2000);
    });
  }

  it('broadcasts a Cursor prompt without spawning the observer SDK', async () => {
    const { routes, broadcasts, chromaSyncs, getInitializeCalls, getGeneratorStarts } = makeRoutes();
    const contentSessionId = '13e1243c-35d3-4e4a-81ef-1ccaa7086d7a';

    const result = await invokeInit(routes, {
      contentSessionId,
      project: 'claude-mem',
      prompt: '为啥我发消息的时候 刷新一下才显示这个呢？',
      platformSource: 'cursor',
    });

    expect(result.skipped).toBe(false);
    expect(result.status).toBe('initialized');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.platform_source).toBe('cursor');
    expect(broadcasts[0]?.prompt_text).toContain('刷新一下才显示这个');
    expect(chromaSyncs).toHaveLength(1);
    expect(getInitializeCalls()).toBe(0);
    expect(getGeneratorStarts()).toBe(0);
  });

  it('still initializes the observer SDK for Claude prompts', async () => {
    const { routes, broadcasts, getInitializeCalls, getGeneratorStarts } = makeRoutes();

    const result = await invokeInit(routes, {
      contentSessionId: 'claude-own-session',
      project: 'claude-mem',
      prompt: 'hello from claude',
      platformSource: 'claude',
    });

    expect(result.skipped).toBe(false);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.platform_source).toBe('claude');
    expect(getInitializeCalls()).toBe(1);
    expect(getGeneratorStarts()).toBe(1);
  });
});
