import { afterAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorAdapter } from '../../../src/cli/adapters/cursor.js';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

/**
 * Snapshot the real namespaces EAGERLY, before the mock.module calls below.
 * `import * as x` yields a live namespace object that bun re-points when the
 * module is mocked, so spreading it later (inside afterAll) would copy the
 * stubs back in and leak them into every test file that runs after this one.
 */
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const calls: unknown[][] = [];
let excludedProjects = '';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false', CLAUDE_MEM_EXCLUDED_PROJECTS: excludedProjects }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: 'parent-project',
    isWorktree: true,
    allProjects: ['parent-project', 'repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    calls.push(args);
    return 'context from worker';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('contextHandler SessionStart path', () => {
  it('delivers Cursor context and refreshes its always-applied rule', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cursor-context-'));
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: 'context-test', cwd, platform: 'cursor' });
      expect(cursorAdapter.formatOutput(result)).toEqual({ continue: true, additional_context: 'context from worker' });
      expect(readFileSync(join(cwd, '.cursor/rules/claude-mem-context.mdc'), 'utf8')).toContain('context from worker');
      excludedProjects = cwd;
      await contextHandler.execute({ sessionId: 'context-test', cwd, platform: 'cursor' });
      expect(existsSync(join(cwd, '.cursor/rules/claude-mem-context.mdc'))).toBe(false);
    } finally {
      excludedProjects = '';
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('injects Codex context with one bounded worker startup and request', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 15_000, timeoutMs: 2_000 },
    ]]);
  });

  it('keeps the existing worker lifecycle behavior for Claude', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await contextHandler.execute({
      sessionId: 'session-context-claude',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project',
      'GET',
      undefined,
      undefined,
    ]]);
  });
});
