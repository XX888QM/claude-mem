import { createHash, randomBytes } from 'crypto';
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join, resolve } from 'path';
import { resolveDataDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export const MAX_TOOL_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_ARCHIVE_TOTAL_BYTES = 1024 * 1024 * 1024;
const ARCHIVE_DIRNAME = 'tool-use-archives';
const ARCHIVE_MARKER = /…\[truncated: (\d+) bytes; raw-archive: ([a-f0-9]{64})\]$/;
const ARCHIVE_LOCK_STALE_MS = 60_000;

export interface ToolUseArchiveIdentity {
  contentSessionId: string;
  toolUseId: string;
  field: 'tool_input' | 'tool_response';
}

/** Original byte size declared by a strictly valid archive marker, if any. */
export function toolUseArchivePayloadBytes(value: string | null): number | null {
  const match = value?.match(ARCHIVE_MARKER);
  if (!match) return null;
  const bytes = Number(match[1]);
  return Number.isSafeInteger(bytes) && bytes > 64 * 1024 && bytes <= MAX_TOOL_ARCHIVE_BYTES ? bytes : null;
}

function archiveDirectory(dataDir = resolveDataDir()): string {
  return join(resolve(dataDir), ARCHIVE_DIRNAME);
}

function archiveId(value: string, identity: ToolUseArchiveIdentity): string {
  return createHash('sha256')
    .update(`v1\0${identity.field}\0${identity.contentSessionId}\0${identity.toolUseId}\0`)
    .update(value, 'utf8')
    .digest('hex');
}

function marker(value: string, archive: string | null, reason?: string): string {
  const suffix = archive
    ? `…[truncated: ${Buffer.byteLength(value, 'utf8')} bytes; raw-archive: ${archive}]`
    : `…[truncated: ${Buffer.byteLength(value, 'utf8')} bytes; archive unavailable: ${reason ?? 'write failed'}]`;
  const buf = Buffer.from(value, 'utf8');
  let end = Math.max(0, 64 * 1024 - Buffer.byteLength(suffix, 'utf8'));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString('utf8')}${suffix}`;
}

function ensureArchiveDirectory(dir: string): void {
  try {
    const dataDir = resolve(dir, '..');
    const dataStat = lstatSync(dataDir);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) throw new Error('unsafe archive data directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const existing = lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('unsafe archive directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(dir, { recursive: false, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

function currentArchiveBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe archive entry');
    total += stat.size;
  }
  return total;
}

export function withArchiveLock<T>(dir: string, action: () => T): T {
  const lockPath = join(dir, '.lock');
  const lockPayload = JSON.stringify({ pid: process.pid, token: randomBytes(12).toString('hex') });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const candidate = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(candidate, lockPayload);
        fsyncSync(candidate);
        fd = candidate;
      } catch (error) {
        releaseFailedArchiveLock(candidate, lockPath);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (breakDeadArchiveLock(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error('archive lock busy');
  try {
    return action();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lockPath, 'utf8') === lockPayload) unlinkSync(lockPath);
    } catch { /* a stale-lock breaker or crash recovery already owns cleanup */ }
  }
}

/** Remove a partially initialized lock only while its inode still belongs to us. */
function releaseFailedArchiveLock(fd: number, lockPath: string): void {
  try {
    const owned = fstatSync(fd);
    const current = lstatSync(lockPath);
    if (!current.isSymbolicLink() && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) {
      unlinkSync(lockPath);
    }
  } catch { /* a competitor may already have replaced or removed the lock */ }
  try { closeSync(fd); } catch { /* preserve the original write/fsync error */ }
}

/** Reap only a stable, old lock whose recorded PID is positively gone. */
function breakDeadArchiveLock(lockPath: string): boolean {
  let before: { mtimeMs: number; content: string; pid: number };
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || Date.now() - stat.mtimeMs < ARCHIVE_LOCK_STALE_MS) return false;
    const content = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(content) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
    before = { mtimeMs: stat.mtimeMs, content, pid: parsed.pid };
    process.kill(before.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs !== before!.mtimeMs || readFileSync(lockPath, 'utf8') !== before!.content) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeArchive(path: string, bytes: Buffer): void {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('archive write stalled');
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    let dirFd: number | undefined;
    try {
      dirFd = openSync(resolve(path, '..'), 'r');
      fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch { /* rename or failed create */ }
  }
}

function readArchive(path: string): Buffer | null {
  const fileStat = lstatSync(path);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('unsafe archive entry');
  if (fileStat.size > MAX_TOOL_ARCHIVE_BYTES) return null;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_TOOL_ARCHIVE_BYTES) return null;
    const raw = readFileSync(fd);
    return raw.length <= MAX_TOOL_ARCHIVE_BYTES ? raw : null;
  } finally {
    closeSync(fd);
  }
}

/** Keeps the SQLite row bounded while retaining approved raw tool content locally. */
export function archiveToolUsePayload(
  value: string,
  identity: ToolUseArchiveIdentity,
  dataDir?: string
): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 64 * 1024) return value;
  if (bytes.length > MAX_TOOL_ARCHIVE_BYTES) {
    logger.warn('DB', 'tool-use raw archive unavailable', { reason: 'exceeds_8_mib', bytes: bytes.length });
    return marker(value, null, 'exceeds 8 MiB limit');
  }

  try {
    const dir = archiveDirectory(dataDir);
    ensureArchiveDirectory(dir);
    return withArchiveLock(dir, () => {
      const id = archiveId(value, identity);
      const path = join(dir, `${id}.raw`);
      const existing = (() => {
        try { return lstatSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      })();
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe archive entry');
        chmodSync(path, 0o600);
        const raw = readArchive(path);
        if (raw && archiveId(raw.toString('utf8'), identity) === id) return marker(value, id);
        logger.warn('DB', 'tool-use raw archive is corrupt; replacing matching record', { archiveId: id });
      }
      if (currentArchiveBytes(dir) - (existing?.size ?? 0) + bytes.length > MAX_TOOL_ARCHIVE_TOTAL_BYTES) {
        logger.warn('DB', 'tool-use raw archive unavailable', { reason: 'archive_quota', bytes: bytes.length });
        return marker(value, null, '1 GiB local archive limit reached');
      }
      writeArchive(path, bytes);
      return marker(value, id);
    });
  } catch (error) {
    logger.warn('DB', 'tool-use raw archive unavailable', { reason: 'write_failed', code: (error as NodeJS.ErrnoException).code });
    return marker(value, null, 'write failed');
  }
}

/** Resolves only a hash-bound, 8 MiB-bounded sidecar; malformed legacy rows stay untouched. */
export function restoreToolUsePayload(
  value: string | null,
  identity: ToolUseArchiveIdentity,
  dataDir?: string,
  maxBytes: number = MAX_TOOL_ARCHIVE_BYTES
): string | null {
  if (value == null) return null;
  const match = value.match(ARCHIVE_MARKER);
  if (!match) return value;
  if (Number(match[1]) > maxBytes) return value;
  try {
    const dir = archiveDirectory(dataDir);
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return value;
    const path = join(dir, `${match[2]}.raw`);
    if (!path.startsWith(`${dir}/`)) return value;
    const raw = readArchive(path);
    if (!raw || raw.length !== Number(match[1]) || raw.length > maxBytes) return value;
    const restored = raw.toString('utf8');
    return archiveId(restored, identity) === match[2] ? restored : value;
  } catch {
    return value;
  }
}
