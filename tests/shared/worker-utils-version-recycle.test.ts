import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';
import * as realKillProcessTree from '../../src/shared/kill-process-tree.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };
const realKillProcessTreeSnapshot = { ...realKillProcessTree };

// On version mismatch the hook must NOT delegate the recycle to the running
// worker (the old design POSTed /api/admin/restart and the dying worker
// spawned its own successor — but that handoff runs the STALE install's
// resolver, so a ≤13.11.0 worker respawns its own version forever, #3378).
// The hook SIGKILLs the stale worker itself and lazy-spawns the resolved
// script.

const PLUGIN_VERSION = '13.4.0';
const STALE_VERSION = '13.3.0';
const STALE_PID = 4242;
const RUNTIME_PLUGIN_VERSION = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string }).version;

// Record every HTTP call so we can assert no /api/admin/restart is issued.
const fetchLog: Array<{ url: string; method: string }> = [];

// Controls what checkVersionMatch reports for a given test.
let versionMatchResult: { matches: boolean; pluginVersion: string; workerVersion: string | null } = {
  matches: true,
  pluginVersion: PLUGIN_VERSION,
  workerVersion: PLUGIN_VERSION,
};

// What the supervisor's PID-file reader reports (null = unidentifiable).
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;

// Simulated process states driving the fetch mock: the stale worker serves
// the port until it is killed; the successor serves it after spawnHidden.
let staleWorkerAlive = true;
let successorUp = false;
let readinessFailuresBeforeSuccess = 0;
let readinessCalls = 0;

// Records every spawn attempt (the lazy-spawn seam, spawnHidden in spawn.ts).
const spawnCalls: Array<{ command: string; args: string[] }> = [];
const killTreeCalls: Array<{
  pid: number;
  options: { signalMode?: 'graceful' | 'immediate'; signal?: AbortSignal } | undefined;
}> = [];

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve(versionMatchResult),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    // A successor started while the stale worker still owns the port cannot
    // become ready; only the post-recycle launch can bind it.
    if (!staleWorkerAlive) successorUp = true;
    return { pid: 5151, unref: () => {} };
  },
}));

mock.module('../../src/shared/kill-process-tree.js', () => ({
  killProcessTree: async (pid: number, options?: { signalMode?: 'graceful' | 'immediate'; signal?: AbortSignal }) => {
    killTreeCalls.push({ pid, options });
    staleWorkerAlive = false;
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-version-recycle=${Date.now()}-${Math.random()}`);
}

function okResponse(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function installFetchMock(): void {
  fetchLog.length = 0;
  readinessCalls = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    const portServed = staleWorkerAlive || successorUp;
    if (!portServed) {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'));
    }
    if (u.includes('/api/readiness')) {
      readinessCalls += 1;
      if (readinessCalls <= readinessFailuresBeforeSuccess) {
        return Promise.resolve({ ok: false } as Response);
      }
    }
    if (u.includes('/api/health')) {
      return okResponse({
        version: staleWorkerAlive ? versionMatchResult.workerVersion : RUNTIME_PLUGIN_VERSION,
      });
    }
    return okResponse({});
  }) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — stale-worker recycle on version mismatch', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;
  beforeEach(() => {
    // The lazy-spawn goes through the spawn gate (worker-spawn-gate.ts),
    // which writes <DATA_DIR>/spawn.lock — point DATA_DIR at a temp dir so
    // the test never touches the real ~/.claude-mem lock.
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-version-recycle-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    installFetchMock();
    spawnCalls.length = 0;
    staleWorkerAlive = true;
    successorUp = false;
    readinessFailuresBeforeSuccess = 0;
    ownedPidInfo = null;
    killTreeCalls.length = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
    mock.module('../../src/shared/kill-process-tree.js', () => realKillProcessTreeSnapshot);
  });

  it('SIGKILLs the stale worker and lazy-spawns the resolved script — never POSTs /api/admin/restart', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(killTreeCalls).toHaveLength(1);
    expect(killTreeCalls[0].pid).toBe(STALE_PID);
    expect(killTreeCalls[0].options?.signalMode).toBe('immediate');
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain('--daemon');
    const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
    expect(restartCalls.length).toBe(0);
  });

  it('recycles a stale ready worker before a bounded Codex hook request', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.executeWithWorkerFallback(
      '/api/test',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 2_000, timeoutMs: 2_000 },
    );

    expect(killTreeCalls).toHaveLength(1);
    expect(killTreeCalls[0].pid).toBe(STALE_PID);
    expect(killTreeCalls[0].options?.signalMode).toBe('immediate');
    expect(killTreeCalls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(spawnCalls).toHaveLength(1);
    expect(fetchLog.some(call => call.url.includes('/api/admin/restart'))).toBe(false);
    expect(result).toEqual({});
  });

  it('recycles a worker that becomes stale-ready during bounded startup', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    readinessFailuresBeforeSuccess = 1;

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.executeWithWorkerFallback(
      '/api/test',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 2_000, timeoutMs: 2_000 },
    );

    expect(killTreeCalls).toHaveLength(1);
    expect(killTreeCalls[0].pid).toBe(STALE_PID);
    expect(killTreeCalls[0].options?.signalMode).toBe('immediate');
    expect(killTreeCalls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({});
  });

  it('does NOT kill or spawn when versions match', async () => {
    versionMatchResult = { matches: true, pluginVersion: PLUGIN_VERSION, workerVersion: PLUGIN_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(killTreeCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
    expect(restartCalls.length).toBe(0);
  });

  it('returns false without killing anything when the PID file does not identify the stale worker', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    ownedPidInfo = null;

    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(false);
    expect(killTreeCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });

  it('proceeds to lazy-spawn after the stale worker tree is gone', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(spawnCalls.length).toBe(1);
  });
});
