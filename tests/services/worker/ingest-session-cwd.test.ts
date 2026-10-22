// #2864 / #2967: the adoption sweep needs to know which directories this
// install actually works in. cwd arrives on every observation ingest but was
// never persisted after the pending_messages queue was removed (61fe70a2,
// v13.10.0), leaving the sweep with no repos to scan. Ingest now stamps it on
// the session row.
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;
let store: SessionStore | undefined;

afterEach(() => {
  try { store?.close(); } catch {}
  store = undefined;
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function wireIngest(sessionStore: SessionStore): Array<{ cwd: string }> {
  const queued: Array<{ cwd: string }> = [];
  setIngestContext({
    sessionManager: {
      queueObservation: (_sessionDbId: number, message: { cwd: string }) => queued.push({ cwd: message.cwd }),
    } as never,
    dbManager: { getSessionStore: () => sessionStore } as never,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as never,
  });
  return queued;
}

describe('ingest persists session cwd (#2864)', () => {
  it('reuses the same-platform session cwd when an observation arrives with root cwd', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-recovery-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const checkout = path.join(tempRoot, 'checkout with space ');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    const queued = wireIngest(store);

    const sessionDbId = store.createSDKSession('content-cwd-recovery', 'checkout', '', undefined, 'codex');
    store.setSessionCwd(sessionDbId, checkout, 'path');

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-recovery',
      platformSource: 'Codex CLI',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: '/' },
      cwd: '/',
    });

    expect(result).toMatchObject({ ok: true, sessionDbId });
    expect(store.getSessionCwd(sessionDbId)).toBe(checkout);
    expect(queued).toEqual([{ cwd: checkout }]);
  });

  it('does not borrow a cwd from another platform with the same content session ID', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-platform-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const checkout = path.join(tempRoot, 'checkout');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const claudeSessionId = store.createSDKSession('content-cwd-platform', 'checkout', '', undefined, 'claude');
    store.setSessionCwd(claudeSessionId, checkout, 'path');

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-platform',
      platformSource: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: '/' },
      cwd: '/',
    });

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'missing_session_cwd' });
    expect(store.findSessionDbIdByContentSessionId('content-cwd-platform', 'codex')).toBeNull();
  });

  it('skips an observation without a trustworthy cwd instead of creating an unknown project session', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-missing-'));
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-missing',
      platformSource: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: '' },
      cwd: '/',
    });

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'missing_session_cwd' });
    expect(store.findSessionDbIdByContentSessionId('content-cwd-missing', 'codex')).toBeNull();
  });

  it.each(['relative/checkout', '/./', '//'])('rejects untrusted cwd %j', async cwd => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-untrusted-'));
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const result = await ingestObservation({
      contentSessionId: `content-cwd-untrusted-${cwd}`,
      platformSource: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: '' },
      cwd,
    });

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'missing_session_cwd' });
    expect(store.findSessionDbIdByContentSessionId(`content-cwd-untrusted-${cwd}`, 'codex')).toBeNull();
  });

  it('uses a valid input cwd for the observation without overwriting the stored launch cwd', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-priority-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const launchCwd = path.join(tempRoot, 'launch');
    const observedCwd = path.join(tempRoot, 'observed');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(launchCwd, { recursive: true });
    mkdirSync(observedCwd, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    const queued = wireIngest(store);
    const sessionDbId = store.createSDKSession('content-cwd-priority', 'launch', '', undefined, 'codex');
    store.setSessionCwd(sessionDbId, launchCwd, 'path');

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-priority',
      platformSource: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: observedCwd },
      cwd: observedCwd,
    });

    expect(result).toMatchObject({ ok: true, sessionDbId });
    expect(queued).toEqual([{ cwd: observedCwd }]);
    expect(store.getSessionCwd(sessionDbId)).toBe(launchCwd);
  });

  it('does not guess when the same-platform session only has a root cwd', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-ingest-cwd-stored-root-'));
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);
    const sessionDbId = store.createSDKSession('content-cwd-stored-root', '', '', undefined, 'codex');
    store.setSessionCwd(sessionDbId, '/');

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-stored-root',
      platformSource: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolResponse: { stdout: '/' },
      cwd: '/./',
    });

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'missing_session_cwd' });
    expect(store.getSessionCwd(sessionDbId)).toBe('/');
  });

  it('stamps the ingest cwd onto the session row', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: tempRoot,
    });

    expect(result.ok).toBe(true);
    const row = store.db.prepare(
      'SELECT cwd FROM sdk_sessions WHERE content_session_id = ?'
    ).get('content-cwd-1') as { cwd: string | null };
    expect(row.cwd).toBe(tempRoot);
  });

  it('keeps the launch cwd when a later observation arrives from a subdirectory', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const subdir = path.join(tempRoot, 'packages', 'api');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(subdir, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    await ingestObservation({
      contentSessionId: 'content-cwd-2',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: tempRoot,
    });
    await ingestObservation({
      contentSessionId: 'content-cwd-2',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: subdir,
    });

    const row = store.db.prepare(
      'SELECT cwd FROM sdk_sessions WHERE content_session_id = ?'
    ).get('content-cwd-2') as { cwd: string | null };
    expect(row.cwd).toBe(tempRoot);
  });

  // Gate P1-2: worktree adoption trusts a deleted checkout only for a
  // folder-derived key, so the checkout is recorded with how its key was derived.
  it('records how the project key was derived with the checkout', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const folderProject = path.join(tempRoot, 'plain-folder');
    const slugRepo = path.join(tempRoot, 'api');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(folderProject, { recursive: true });
    mkdirSync(slugRepo, { recursive: true });
    execFileSync('git', ['init', '-q', slugRepo], { stdio: 'ignore' });
    execFileSync('git', ['-C', slugRepo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'], { stdio: 'ignore' });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const savedNameSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      for (const [contentSessionId, cwd] of [['content-folder', folderProject], ['content-slug', slugRepo]]) {
        await ingestObservation({
          contentSessionId,
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          toolResponse: { stdout: '' },
          cwd,
        });
      }
    } finally {
      if (savedNameSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = savedNameSource;
    }

    const sources = store.db.prepare(
      'SELECT content_session_id, project, project_key_source FROM sdk_sessions ORDER BY content_session_id'
    ).all();
    expect(sources).toEqual([
      { content_session_id: 'content-folder', project: 'plain-folder', project_key_source: 'path' },
      { content_session_id: 'content-slug', project: 'acme/api', project_key_source: 'git-remote' },
    ]);
  });
});

