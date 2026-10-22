import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { closeSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MAX_TOOL_PAYLOAD_BYTES, truncatePayload } from '../../src/services/sqlite/tool-uses.js';
import {
  archiveToolUsePayload,
  MAX_TOOL_ARCHIVE_BYTES,
  MAX_TOOL_ARCHIVE_TOTAL_BYTES,
  restoreToolUsePayload,
  withArchiveLock,
} from '../../src/services/sqlite/tool-use-archive.js';

interface TableColumnInfo {
  name: string;
}

interface SchemaVersionRow {
  version: number;
}

function toolUsesColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(tool_uses)').all() as TableColumnInfo[]).map(col => col.name);
}

function hasTable(db: Database, name: string): boolean {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(name) as unknown[]).length > 0;
}

/**
 * Seed a pre-v51 database: the constructor chain fills in everything else, but
 * neither `tool_uses` nor the v51 stamp exists yet.
 */
function seedLegacyDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(50, new Date().toISOString());
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    toolUseId: 'toolu_01',
    contentSessionId: 'content-session-a',
    project: 'claude-mem',
    toolName: 'Read',
    toolInput: '{"file_path":"/tmp/a.ts"}',
    toolResponse: '{"ok":true}',
    cwd: '/workspace/claude-mem',
    promptNumber: 3,
    ...overrides,
  } as Parameters<SessionStore['upsertToolUse']>[0];
}

describe('SessionStore tool_uses (v51)', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  describe('migration', () => {
    it('creates tool_uses on a fresh database with the frozen column set', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);

      expect(hasTable(db, 'tool_uses')).toBe(true);

      const columns = toolUsesColumns(db);
      for (const expected of [
        'id', 'tool_use_id', 'content_session_id', 'memory_session_id', 'session_db_id',
        'project', 'platform_source', 'tool_name', 'tool_input', 'tool_response', 'cwd',
        'prompt_number', 'agent_type', 'agent_id', 'observation_id',
        'or_generation_id', 'or_session_id', 'content_hash', 'created_at', 'created_at_epoch',
      ]) {
        expect(columns).toContain(expected);
      }
    });

    it('carries the Receipt-frozen OR join columns and no cost column', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);

      const columns = toolUsesColumns(db);
      expect(columns).toContain('or_generation_id');
      expect(columns).toContain('or_session_id');
      // Receipt freeze 2026-09-06: dollars live on OR stamps / the spend log.
      expect(columns).not.toContain('cost_usd');
      expect(columns.some(c => c.includes('cost'))).toBe(false);
      expect(columns.some(c => c.includes('micros'))).toBe(false);
    });

    it('migrates an existing pre-v51 database and stamps schema version 51', () => {
      const db = new Database(':memory:');
      seedLegacyDb(db);
      expect(hasTable(db, 'tool_uses')).toBe(false);

      store = new SessionStore(db);

      expect(hasTable(db, 'tool_uses')).toBe(true);
      const versions = (db.query('SELECT version FROM schema_versions').all() as SchemaVersionRow[])
        .map(row => row.version);
      expect(versions).toContain(51);
    });

    it('leaves pending_messages intact (queue is not repurposed)', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);
      expect(hasTable(db, 'pending_messages')).toBe(true);
    });

    it('re-running the constructor over the same database is a no-op', () => {
      const db = new Database(':memory:');
      const first = new SessionStore(db);
      first.upsertToolUse(baseInput());

      // Second SessionStore over the same handle re-runs the whole chain.
      const second = new SessionStore(db);
      store = second;

      expect(second.queryToolUses({ contentSessionId: 'content-session-a' })).toHaveLength(1);
    });
  });

  describe('upsertToolUse', () => {
    it('inserts a row and returns its id', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput());

      expect(id).toBeGreaterThan(0);

      const [row] = store.queryToolUses({ contentSessionId: 'content-session-a' });
      expect(row.tool_name).toBe('Read');
      expect(row.tool_input).toBe('{"file_path":"/tmp/a.ts"}');
      expect(row.tool_response).toBe('{"ok":true}');
      expect(row.project).toBe('claude-mem');
      expect(row.platform_source).toBe('claude');
      expect(row.content_hash).toBeTruthy();
      expect(row.observation_id).toBeNull();
    });

    it('is idempotent on replay of the same (content_session_id, tool_use_id)', () => {
      store = new SessionStore(new Database(':memory:'));
      const first = store.upsertToolUse(baseInput());
      const second = store.upsertToolUse(baseInput());

      expect(second).toBe(first);
      expect(store.queryToolUses({ contentSessionId: 'content-session-a' })).toHaveLength(1);
    });

    it('lets a replay fill in a tool_response the first write lacked', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolResponse: null }));
      store.upsertToolUse(baseInput({ toolResponse: '{"ok":true}' }));

      const [row] = store.queryToolUses({ contentSessionId: 'content-session-a' });
      expect(row.tool_response).toBe('{"ok":true}');
    });

    it('treats the same tool_use_id in a different session as a distinct row', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());
      store.upsertToolUse(baseInput({ contentSessionId: 'content-session-b' }));

      expect(store.queryToolUses({})).toHaveLength(2);
    });

    it('skips a tool event with no tool_use_id rather than inserting a duplicate-prone row', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.upsertToolUse(baseInput({ toolUseId: '' }))).toBeNull();
      expect(store.queryToolUses({})).toHaveLength(0);
    });

    it('excludes OpenCode native claude_mem_search from the raw backup only', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.upsertToolUse(baseInput({ toolName: 'claude_mem_search' }))).toBeNull();
      expect(store.queryToolUses({})).toEqual([]);
    });

    it('stores the OR join keys when a stamper supplies them', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({
        orGenerationId: 'gen-abc123',
        orSessionId: 'job:content-session-a',
      }));

      const [row] = store.queryToolUses({});
      expect(row.or_generation_id).toBe('gen-abc123');
      expect(row.or_session_id).toBe('job:content-session-a');
    });

    it('keeps the SQLite row bounded but transparently restores archived UTF-8 payloads', () => {
      store = new SessionStore(new Database(':memory:'));
      const huge = '€'.repeat(Math.ceil((MAX_TOOL_PAYLOAD_BYTES + 5000) / 3));
      store.upsertToolUse(baseInput({ toolResponse: huge }));

      const [row] = store.queryToolUses({});
      expect(Buffer.byteLength(row.tool_response!, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD_BYTES);
      expect(row.tool_response).toContain('raw-archive:');
      const raw = store.db.query('SELECT tool_response FROM tool_uses').get() as { tool_response: string };
      expect(Buffer.byteLength(raw.tool_response, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD_BYTES);
      expect(raw.tool_response).toContain('raw-archive:');
      const restored = store.getToolUsesByIds([row.id]);
      expect(restored[0].tool_response).toBe(huge);
    });

    it('never splits a multi-byte character when truncating', () => {
      const value = '€'.repeat(MAX_TOOL_PAYLOAD_BYTES); // 3 bytes each
      const truncated = truncatePayload(value);
      expect(truncated).toContain('[truncated:');
      expect(truncated.includes('�')).toBe(false);
    });
  });

  describe('raw tool archive', () => {
    let dataDir: string;
    const identity = { contentSessionId: 'archive-session', toolUseId: 'archive-tool', field: 'tool_response' as const };

    afterEach(() => {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });

    it('accepts exactly 8 MiB, is idempotent, and restores it', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const original = 'x'.repeat(MAX_TOOL_ARCHIVE_BYTES);
      const first = archiveToolUsePayload(original, identity, dataDir);
      const second = archiveToolUsePayload(original, identity, dataDir);
      expect(first).toBe(second);
      expect(restoreToolUsePayload(first, identity, dataDir)).toBe(original);
      const id = first.match(/raw-archive: ([a-f0-9]{64})/)![1];
      const archivePath = join(dataDir, 'tool-use-archives', `${id}.raw`);
      writeFileSync(archivePath, 'corrupt');
      expect(archiveToolUsePayload(original, identity, dataDir)).toBe(first);
      expect(restoreToolUsePayload(first, identity, dataDir)).toBe(original);
      expect(readdirSync(join(dataDir, 'tool-use-archives')).filter(name => name.endsWith('.raw'))).toHaveLength(1);
      expect(lstatSync(join(dataDir, 'tool-use-archives')).mode & 0o777).toBe(0o700);
    });

    it('rejects payloads over 8 MiB and preserves a readable truncated row', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const row = archiveToolUsePayload('x'.repeat(MAX_TOOL_ARCHIVE_BYTES + 1), identity, dataDir);
      expect(row).toContain('archive unavailable: exceeds 8 MiB limit');
      expect(Buffer.byteLength(row, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD_BYTES);
      expect(restoreToolUsePayload(row, identity, dataDir)).toBe(row);
    });

    it('counts existing files toward the 1 GiB quota', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const archiveDir = join(dataDir, 'tool-use-archives');
      mkdirSync(archiveDir, { mode: 0o700 });
      const fd = openSync(join(archiveDir, 'existing.raw'), 'w', 0o600);
      ftruncateSync(fd, MAX_TOOL_ARCHIVE_TOTAL_BYTES);
      closeSync(fd);
      const row = archiveToolUsePayload('x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 1), identity, dataDir);
      expect(row).toContain('archive unavailable: 1 GiB local archive limit reached');
    });

    it('rejects symlink archives and untrusted marker IDs without reading outside the archive', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const outside = join(dataDir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(dataDir, 'tool-use-archives'));
      const row = archiveToolUsePayload('x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 1), identity, dataDir);
      expect(row).toContain('archive unavailable: write failed');
      const traversal = 'prefix…[truncated: 99999 bytes; raw-archive: ../../outside]';
      expect(restoreToolUsePayload(traversal, identity, dataDir)).toBe(traversal);
    });

    it('does not follow a symlink substituted for an archived payload', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const original = 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 100);
      const row = archiveToolUsePayload(original, identity, dataDir);
      const id = row.match(/raw-archive: ([a-f0-9]{64})/)![1];
      const archivePath = join(dataDir, 'tool-use-archives', `${id}.raw`);
      const outside = join(dataDir, 'outside.raw');
      writeFileSync(outside, 'not the archived value');
      unlinkSync(archivePath);
      symlinkSync(outside, archivePath);
      expect(restoreToolUsePayload(row, identity, dataDir)).toBe(row);
    });

    it('leaves legacy bounded rows unchanged and will not restore a copied archive marker', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const original = 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 1);
      const row = archiveToolUsePayload(original, identity, dataDir);
      expect(restoreToolUsePayload('legacy bounded row', identity, dataDir)).toBe('legacy bounded row');
      expect(restoreToolUsePayload(row, { ...identity, contentSessionId: 'other-session' }, dataDir)).toBe(row);
    });

    it('does not restore an archive when a forged marker understates its byte size', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const original = 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 100);
      const row = archiveToolUsePayload(original, identity, dataDir);
      const forged = row.replace(/truncated: \d+ bytes/, 'truncated: 65537 bytes');
      expect(restoreToolUsePayload(forged, identity, dataDir)).toBe(forged);
    });

    it('recovers only an old lock whose recorded PID is gone', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const archiveDir = join(dataDir, 'tool-use-archives');
      mkdirSync(archiveDir, { mode: 0o700 });
      const lockPath = join(archiveDir, '.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, token: 'dead' }), { mode: 0o600 });
      const old = new Date(Date.now() - 61_000);
      utimesSync(lockPath, old, old);
      const row = archiveToolUsePayload('x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 1), identity, dataDir);
      expect(row).toContain('raw-archive:');
      expect(restoreToolUsePayload(row, identity, dataDir)).toBe('x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 1));
    });

    it('releases a fully initialized lock so the next caller can acquire it', () => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-tool-archive-'));
      const archiveDir = join(dataDir, 'tool-use-archives');
      mkdirSync(archiveDir, { mode: 0o700 });
      expect(withArchiveLock(archiveDir, () => 'first')).toBe('first');
      expect(withArchiveLock(archiveDir, () => 'second')).toBe('second');
      expect(readdirSync(archiveDir)).not.toContain('.lock');
    });
  });

  describe('linkToolUsesToObservation', () => {
    it('links the named tool uses and backfills memory_session_id', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'toolu_01' }));
      store.upsertToolUse(baseInput({ toolUseId: 'toolu_02' }));

      const updated = store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01', 'toolu_02'],
        observationId: 4242,
        memorySessionId: 'memory-session-a',
      });

      expect(updated).toBe(2);
      for (const row of store.queryToolUses({})) {
        expect(row.observation_id).toBe(4242);
        expect(row.memory_session_id).toBe('memory-session-a');
      }
    });

    it('does not steal an existing observation link', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());
      store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01'],
        observationId: 1,
      });
      store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01'],
        observationId: 2,
      });

      const [row] = store.queryToolUses({});
      expect(row.observation_id).toBe(1);
    });

    it('ignores an empty id list', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: [],
        observationId: 1,
      })).toBe(0);
    });
  });

  describe('getToolUsesByIds', () => {
    it('caps one explicit raw fetch to 32 MiB before reading further archives', () => {
      store = new SessionStore(new Database(':memory:'));
      const payload = 'x'.repeat(MAX_TOOL_ARCHIVE_BYTES);
      const ids = Array.from({ length: 5 }, (_, index) => store.upsertToolUse(baseInput({
        toolUseId: `budget-${index}`,
        toolResponse: payload,
      }))!);
      const rows = store.getToolUsesByIds(ids);
      expect(rows.filter(row => row.tool_response === payload)).toHaveLength(4);
      expect(rows.filter(row => row.tool_response?.includes('raw-archive:'))).toHaveLength(1);
    });

    it('fetches by numeric row id', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput())!;

      const rows = store.getToolUsesByIds([id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_use_id).toBe('toolu_01');
    });

    it('fetches by opaque tool_use_id string', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());

      const rows = store.getToolUsesByIds(['toolu_01']);
      expect(rows).toHaveLength(1);
    });

    it('applies a project filter', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput())!;

      expect(store.getToolUsesByIds([id], { project: 'claude-mem' })).toHaveLength(1);
      expect(store.getToolUsesByIds([id], { project: 'other-project' })).toHaveLength(0);
    });

    it('returns [] for an empty or unusable id list', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.getToolUsesByIds([])).toEqual([]);
      expect(store.getToolUsesByIds(['   '])).toEqual([]);
    });
  });

  describe('queryToolUses / countToolUses', () => {
    it('filters by tool_name and orders newest first', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read', createdAtEpoch: 1000 }));
      store.upsertToolUse(baseInput({ toolUseId: 'b', toolName: 'Edit', createdAtEpoch: 2000 }));
      store.upsertToolUse(baseInput({ toolUseId: 'c', toolName: 'Read', createdAtEpoch: 3000 }));

      const reads = store.queryToolUses({ toolName: 'Read' });
      expect(reads.map(r => r.tool_use_id)).toEqual(['c', 'a']);
    });

    it('counts DISTINCT tool_use_id per tool for Receipt tallies', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read' }));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read' })); // replay
      store.upsertToolUse(baseInput({ toolUseId: 'b', toolName: 'Read' }));
      store.upsertToolUse(baseInput({ toolUseId: 'c', toolName: 'Edit' }));

      expect(store.countToolUses({ contentSessionId: 'content-session-a' })).toEqual([
        { tool_name: 'Read', uses: 2 },
        { tool_name: 'Edit', uses: 1 },
      ]);
    });
  });
});
