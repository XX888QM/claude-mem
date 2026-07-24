import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
  type ReadStream,
  type Stats,
} from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';

interface TailState {
  offset: number;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private fileDescriptor: number | null = null;
  private fileIdentity: string | null = null;
  private activeStream: ReadStream | null = null;
  private tailState: TailState;
  private reading = false;
  private readAgain = false;
  private renameQueued = false;
  private closed = false;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void,
    private onMissing: () => void,
    private startAtEnd = false,
  ) {
    this.tailState = { offset: initialOffset };
  }

  start(): void {
    this.watchFile();
    this.queueRead();
  }

  reopen(): void {
    if (this.closed) return;
    this.watcher?.close();
    this.watcher = null;
    this.watchFile();
    this.queueRead();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readAgain = false;
    this.watcher?.close();
    this.watcher = null;
    this.activeStream?.destroy();
    this.activeStream = null;
    this.closeFile();
  }

  poke(): void {
    if (this.closed) return;
    if (!this.watcher) this.watchFile();
    this.queueRead();
  }

  private async readNewData(): Promise<void> {
    if (this.closed) return;
    const file = this.openCurrentFile();
    if (!file || this.closed) return;
    const { descriptor, size } = file;

    if (size < this.tailState.offset) this.resetOffset(0);

    if (size === this.tailState.offset) return;
    const startOffset = this.tailState.offset;

    const stream = createReadStream(this.filePath, {
      fd: descriptor,
      autoClose: false,
      start: startOffset,
      end: size - 1,
    });
    this.activeStream = stream;

    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        if (this.closed) return;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } finally {
      if (this.activeStream === stream) this.activeStream = null;
    }

    if (this.closed) return;
    const data = Buffer.concat(chunks);
    let lineStart = 0;
    let newline = data.indexOf(0x0a);
    while (newline !== -1) {
      const trimmed = data.subarray(lineStart, newline).toString('utf8').trim();
      if (trimmed) await this.onLine(trimmed);
      if (this.closed) return;
      this.tailState.offset = startOffset + newline + 1;
      this.onOffset(this.tailState.offset);
      lineStart = newline + 1;
      newline = data.indexOf(0x0a, lineStart);
    }
  }

  private watchFile(): void {
    if (this.closed || this.watcher) return;
    try {
      const watcher = fsWatch(this.filePath, { persistent: true }, (event) => {
        if (this.closed) return;
        if (event === 'rename') {
          this.queueRename();
          return;
        }
        this.queueRead();
      });
      watcher.on('error', (error) => {
        if (this.closed || this.watcher !== watcher) return;
        queueMicrotask(() => {
          if (this.closed || this.watcher !== watcher) return;
          watcher.close();
          this.watcher = null;
          logger.warn('TRANSCRIPT', 'Transcript file watcher failed; recursive watcher will retry it', {
            file: this.filePath,
          }, error);
          if (!existsSync(this.filePath)) this.notifyMissing();
        });
      });
      this.watcher = watcher;
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to watch transcript file; recursive watcher will retry it', {
        file: this.filePath,
      }, error instanceof Error ? error : undefined);
      if (!existsSync(this.filePath)) this.notifyMissing();
    }
  }

  private queueRename(): void {
    if (this.closed || this.renameQueued) return;
    this.renameQueued = true;
    queueMicrotask(() => {
      this.renameQueued = false;
      if (this.closed) return;
      if (!existsSync(this.filePath)) {
        this.notifyMissing();
        return;
      }
      this.reopen();
    });
  }

  private queueRead(): void {
    if (this.closed) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    this.readNewData()
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        if (!this.closed && this.readAgain) {
          this.readAgain = false;
          this.queueRead();
        }
      });
  }

  private openCurrentFile(): { descriptor: number; size: number } | null {
    let pathStat: Stats;
    try {
      pathStat = statSync(this.filePath);
    } catch (error: unknown) {
      if (!existsSync(this.filePath)) {
        this.notifyMissing();
      } else {
        logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      }
      return null;
    }

    const pathIdentity = this.identityOf(pathStat);
    if (this.fileDescriptor !== null && this.fileIdentity === pathIdentity) {
      return { descriptor: this.fileDescriptor, size: pathStat.size };
    }

    let nextDescriptor: number;
    try {
      nextDescriptor = openSync(this.filePath, 'r');
    } catch (error: unknown) {
      if (!existsSync(this.filePath)) {
        this.notifyMissing();
      } else {
        logger.debug('WORKER', 'Failed to open transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      }
      return null;
    }

    if (this.closed) {
      closeSync(nextDescriptor);
      return null;
    }

    const nextStat = fstatSync(nextDescriptor);
    const nextIdentity = this.identityOf(nextStat);
    const previousDescriptor = this.fileDescriptor;
    const samePrefix = previousDescriptor === null
      || (nextStat.size >= this.tailState.offset
        && this.prefixMatches(previousDescriptor, nextDescriptor, this.tailState.offset));

    this.fileDescriptor = nextDescriptor;
    this.fileIdentity = nextIdentity;
    if (previousDescriptor !== null) closeSync(previousDescriptor);
    if (previousDescriptor === null && nextStat.size < this.tailState.offset) {
      this.resetOffset(this.startAtEnd ? nextStat.size : 0);
    } else if (!samePrefix) {
      this.resetOffset(0);
    }

    return { descriptor: nextDescriptor, size: nextStat.size };
  }

  private prefixMatches(leftDescriptor: number, rightDescriptor: number, length: number): boolean {
    const left = Buffer.allocUnsafe(Math.min(64 * 1024, length));
    const right = Buffer.allocUnsafe(left.length);
    let position = 0;

    while (position < length) {
      const chunkSize = Math.min(left.length, length - position);
      const leftRead = readSync(leftDescriptor, left, 0, chunkSize, position);
      const rightRead = readSync(rightDescriptor, right, 0, chunkSize, position);
      if (leftRead !== chunkSize || rightRead !== chunkSize) return false;
      if (!left.subarray(0, chunkSize).equals(right.subarray(0, chunkSize))) return false;
      position += chunkSize;
    }

    return true;
  }

  private resetOffset(offset: number): void {
    if (this.tailState.offset === offset) return;
    this.tailState.offset = offset;
    if (!this.closed) this.onOffset(offset);
  }

  private notifyMissing(): void {
    if (!this.closed) this.onMissing();
  }

  private closeFile(): void {
    if (this.fileDescriptor === null) return;
    try {
      closeSync(this.fileDescriptor);
    } catch {
      // The active stream may have completed the close while shutdown raced it.
    }
    this.fileDescriptor = null;
    this.fileIdentity = null;
  }

  private identityOf(stat: Stats): string {
    return `${stat.dev}:${stat.ino}`;
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private removedTailerPaths = new Set<string>();
  private state: TranscriptWatchState;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
  private rootRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private config: TranscriptWatchConfig, private statePath: string) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    this.removedTailerPaths.clear();
    for (const watcher of this.rootWatchers) {
      watcher.close();
    }
    this.rootWatchers = [];
    for (const timer of this.rootRetryTimers) clearTimeout(timer);
    this.rootRetryTimers.clear();
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema);
    }

    const watchRoot = this.deepestNonGlobAncestor(resolvedPath);
    this.startRootWatcher(watchRoot, resolvedPath, watch, schema);
  }

  private startRootWatcher(
    watchRoot: string,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
  ): void {
    if (this.stopped) return;
    if (!watchRoot) {
      logger.debug('TRANSCRIPT', 'Cannot determine transcript watch root, skipping fs.watch', { watch: watch.name });
      return;
    }
    if (!existsSync(watchRoot)) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, retrying fs.watch', { watch: watch.name, watchRoot });
      this.scheduleRootWatchRetry(watchRoot, resolvedPath, watch, schema);
      return;
    }

    try {
      const watcher = fsWatch(watchRoot, { recursive: true, persistent: true }, (event, name) => {
        this.handleRootWatchEvent(watchRoot, resolvedPath, watch, schema, name, event);
      });
      this.rootWatchers.push(watcher);
      watcher.on('error', (error) => {
        if (this.stopped || !this.rootWatchers.includes(watcher)) return;
        queueMicrotask(() => {
          if (this.stopped || !this.rootWatchers.includes(watcher)) return;
          this.rootWatchers = this.rootWatchers.filter(candidate => candidate !== watcher);
          watcher.close();
          logger.warn('TRANSCRIPT', 'Recursive transcript watcher failed; retrying', {
            watch: watch.name,
            watchRoot,
          }, error);
          this.scheduleRootWatchRetry(watchRoot, resolvedPath, watch, schema);
        });
      });
      for (const filePath of this.resolveWatchFiles(resolvedPath)) {
        if (!this.tailers.has(filePath)) void this.addTailer(filePath, watch, schema, true);
      }
      logger.info('TRANSCRIPT', 'Watching transcript root recursively', { watch: watch.name, watchRoot });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to start recursive fs.watch on transcript root', {
        watch: watch.name,
        watchRoot,
      }, error instanceof Error ? error : undefined);
      this.scheduleRootWatchRetry(watchRoot, resolvedPath, watch, schema);
    }
  }

  private scheduleRootWatchRetry(
    watchRoot: string,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
  ): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.rootRetryTimers.delete(timer);
      if (this.stopped) return;
      this.startRootWatcher(watchRoot, resolvedPath, watch, schema);
    }, 100);
    this.rootRetryTimers.add(timer);
  }

  private handleRootWatchEvent(
    watchRoot: string,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    name: string | null,
    event?: string,
  ): void {
    if (this.stopped || !name) return;
    const changed = resolvePath(watchRoot, name).replace(/\\/g, '/');
    const existingTailer = this.tailers.get(changed);
    if (existingTailer) {
      if (!existsSync(changed)) {
        this.removeTailer(changed, existingTailer);
      } else if (event === 'rename') {
        existingTailer.reopen();
      } else {
        existingTailer.poke();
      }
      return;
    }
    const matches = this.resolveWatchFiles(resolvedPath);
    for (const filePath of matches) {
      if (!this.tailers.has(filePath)) {
        void this.addTailer(filePath, watch, schema, true);
      }
    }
  }

  private deepestNonGlobAncestor(inputPath: string): string {
    if (!this.hasGlob(inputPath)) {
      if (existsSync(inputPath)) {
        try {
          const stat = statSync(inputPath);
          return stat.isDirectory() ? inputPath : resolvePath(inputPath, '..');
        } catch (error: unknown) {
          logger.debug('TRANSCRIPT', 'Failed to stat watch path ancestor, falling back to parent directory', { path: inputPath }, error instanceof Error ? error : new Error(String(error)));
          return resolvePath(inputPath, '..');
        }
      }
      return inputPath;
    }

    const segments = inputPath.split(/[/\\]/);
    const literalSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?[\]{}()]/.test(segment)) break;
      literalSegments.push(segment);
    }
    if (literalSegments.length === 0) return '';
    if (literalSegments.length === 1 && literalSegments[0] === '') {
      return '';
    }
    return literalSegments.join(pathSep);
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return this.scanGlob(this.normalizeGlobPattern(inputPath));
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return this.scanGlob(this.normalizeGlobPattern(pattern));
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private scanGlob(pattern: string): string[] {
    return Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true }));
  }

  private normalizeGlobPattern(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    _discoveredAfterStart = false,
  ): Promise<void> {
    if (this.stopped || this.tailers.has(filePath)) return;

    // Skip ephemeral observer CLI workdirs (deleted after each Grok/Codex call)
    // so fs.watch does not throw ENOENT spam against vanished temp sessions.
    if (this.isEphemeralObserverTranscriptPath(filePath)) {
      logger.debug('TRANSCRIPT', 'Skipping ephemeral observer transcript path', { file: filePath });
      return;
    }

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);
    const cwdOverride = this.extractCwdFromGrokPath(filePath, watch);

    const savedOffset = this.state.offsets[filePath];
    const inheritedOffset = savedOffset === undefined
      ? this.findOriginalCodexOffset(filePath, schema)
      : undefined;
    let offset = savedOffset ?? inheritedOffset ?? 0;
    const rediscoveredAfterRemoval = this.removedTailerPaths.delete(filePath);
    if (
      watch.startAtEnd
      && (rediscoveredAfterRemoval || (savedOffset === undefined && inheritedOffset === undefined))
    ) {
      try {
        offset = statSync(filePath).size;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
      this.state.offsets[filePath] = offset;
      saveWatchState(this.statePath, this.state);
    }

    let tailer: FileTailer;
    tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        if (this.stopped || this.tailers.get(filePath) !== tailer) return;
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride, cwdOverride);
      },
      (newOffset: number) => {
        if (this.stopped || this.tailers.get(filePath) !== tailer) return;
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      },
      () => this.removeTailer(filePath, tailer),
      watch.startAtEnd,
    );

    this.tailers.set(filePath, tailer);
    tailer.start();
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private removeTailer(filePath: string, tailer: FileTailer): void {
    if (this.tailers.get(filePath) !== tailer) return;
    tailer.close();
    this.tailers.delete(filePath);
    this.removedTailerPaths.add(filePath);
  }

  private findOriginalCodexOffset(filePath: string, schema: TranscriptSchema): number | undefined {
    const normalized = filePath.replace(/\\/g, '/');
    if (schema.name !== 'codex' || !/\/\.codex\/archived_sessions\//i.test(normalized)) {
      return undefined;
    }

    const fileName = basename(filePath);
    const original = Object.entries(this.state.offsets).find(([candidate]) => {
      const normalizedCandidate = candidate.replace(/\\/g, '/');
      return /\/\.codex\/sessions\//i.test(normalizedCandidate)
        && basename(candidate) === fileName;
    });

    if (!original) return undefined;

    try {
      return Math.min(original[1], statSync(filePath).size);
    } catch {
      return original[1];
    }
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null,
    cwdOverride?: string | null,
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      await this.processor.processEntry(
        entry,
        watch,
        schema,
        sessionIdOverride ?? undefined,
        cwdOverride ?? undefined,
      );
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
    }
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }

  private isEphemeralObserverTranscriptPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    // Only skip observer CLI workdirs that leak into Grok/Codex session trees.
    // Do NOT blanket-skip /var/folders — unit tests and legitimate temp watches
    // use those paths.
    const underGrokOrCodexSessions =
      /\/\.grok\/sessions\//i.test(normalized)
      || /\/\.codex\/sessions\//i.test(normalized)
      || /\/\.codex\/archived_sessions\//i.test(normalized);

    if (!underGrokOrCodexSessions) return false;

    return (
      /claude-mem-grok-/i.test(normalized)
      || /claude-mem-codex-/i.test(normalized)
      || /%2Fprivate%2Fvar%2Ffolders/i.test(normalized)
      || /%2Fvar%2Ffolders/i.test(normalized)
      || /%2Ftmp%2Fclaude-mem-/i.test(normalized)
      || /\/private\/var\/folders\//i.test(normalized)
      || /\/tmp\/claude-mem-grok-/i.test(normalized)
      || /\/tmp\/claude-mem-codex-/i.test(normalized)
    );
  }

  /**
   * Grok stores sessions as:
   *   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl
   * Decode the parent folder when the watch is named/schemad as grok.
   */
  private extractCwdFromGrokPath(filePath: string, watch: WatchTarget): string | null {
    const schemaName = typeof watch.schema === 'string' ? watch.schema : watch.schema?.name;
    const isGrok = watch.name === 'grok' || schemaName === 'grok';
    if (!isGrok) return null;

    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/\/sessions\/([^/]+)\/[0-9a-f-]{36}\//i);
    if (!match?.[1]) return null;

    try {
      const decoded = decodeURIComponent(match[1]);
      return decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
}
