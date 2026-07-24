import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this partial session-init stub would
// otherwise leak into other test files in the same `bun test` run.
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));
const TEST_SESSION_ID = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
const entry = (message: string) => `${JSON.stringify({
  type: 'event',
  payload: { type: 'user_message', session_id: TEST_SESSION_ID, message },
})}\n`;
const schema: TranscriptSchema = {
  name: 'codex-test',
  events: [{
    name: 'user-message',
    match: { path: 'payload.type', equals: 'user_message' },
    action: 'session_init',
    fields: { sessionId: 'payload.session_id', prompt: 'payload.message' },
  }],
};

describe('TranscriptWatcher startAtEnd', () => {
  let tmpRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-transcript-watch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not replay history from transcript files discovered after startup', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');

    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: 'event',
        payload: {
          type: 'user_message',
          session_id: sessionId,
          message: 'historical prompt that must not be replayed',
        },
      })}\n`,
      'utf8',
    );

    const schema: TranscriptSchema = {
      name: 'codex-test',
      events: [
        {
          name: 'user-message',
          match: { path: 'payload.type', equals: 'user_message' },
          action: 'session_init',
          fields: {
            sessionId: 'payload.session_id',
            prompt: 'payload.message',
          },
        },
      ],
    };
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();

    expect(sessionInitCalls).toHaveLength(0);

    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'event',
        payload: {
          type: 'user_message',
          session_id: sessionId,
          message: 'live prompt',
        },
      })}\n`,
      'utf8',
    );

    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toContain('live prompt');
    expect(prompts).not.toContain('historical prompt that must not be replayed');
  });

  it('resumes a saved offset discovered after startup and persists it for restart', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const entry = (message: string) => `${JSON.stringify({
      type: 'event',
      payload: { type: 'user_message', session_id: sessionId, message },
    })}\n`;
    const oldHistory = entry('old history');
    const skippedHistory = entry('history discovered after startup');
    writeFileSync(filePath, oldHistory + skippedHistory, 'utf8');
    writeFileSync(statePath, JSON.stringify({ offsets: { [filePath]: Buffer.byteLength(oldHistory) } }), 'utf8');

    const schema: TranscriptSchema = {
      name: 'codex-test',
      events: [{
        name: 'user-message',
        match: { path: 'payload.type', equals: 'user_message' },
        action: 'session_init',
        fields: { sessionId: 'payload.session_id', prompt: 'payload.message' },
      }],
    };
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };

    const firstWatcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (firstWatcher as any).addTailer(filePath, watch, schema, true);
    await waitForAsyncTail();
    firstWatcher.stop();

    expect(sessionInitCalls.map(call => call.prompt))
      .toEqual(['history discovered after startup']);
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.offsets[filePath]).toBe(Buffer.byteLength(oldHistory + skippedHistory));

    const restartedWatcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (restartedWatcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    expect(sessionInitCalls).toHaveLength(1);

    appendFileSync(filePath, entry('live after restart'));
    (restartedWatcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    restartedWatcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual([
      'history discovered after startup',
      'live after restart',
    ]);
  });

  it('continues from the saved offset across an atomic replacement', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const fileName = `${sessionId}.jsonl`;
    const filePath = join(tmpRoot, fileName);
    const replacementPath = join(tmpRoot, 'replacement.tmp');
    const statePath = join(tmpRoot, 'state.json');
    const entry = (message: string) => `${JSON.stringify({
      type: 'event',
      payload: { type: 'user_message', session_id: sessionId, message },
    })}\n`;
    const history = entry('history before watch');
    writeFileSync(filePath, history, 'utf8');

    const schema: TranscriptSchema = {
      name: 'codex-test',
      events: [{
        name: 'user-message',
        match: { path: 'payload.type', equals: 'user_message' },
        action: 'session_init',
        fields: { sessionId: 'payload.session_id', prompt: 'payload.message' },
      }],
    };
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();

    writeFileSync(replacementPath, history + entry('live in atomic replacement'), 'utf8');
    renameSync(replacementPath, filePath);
    await waitForAsyncTail();

    appendFileSync(filePath, entry('live after atomic replacement'));
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual([
      'live in atomic replacement',
      'live after atomic replacement',
    ]);
  });

  it.each([
    [
      'shorter',
      entry('history before watch '.repeat(20)),
      entry('new shorter replacement'),
      ['new shorter replacement'],
    ],
    [
      'same-sized with different content',
      entry('old content'),
      entry('new content'),
      ['new content'],
    ],
    [
      'larger with different content',
      entry('old'),
      entry('new first') + entry('new second'),
      ['new first', 'new second'],
    ],
  ])('reads a %s atomic replacement as new content', async (
    _caseName,
    original,
    replacement,
    expected,
  ) => {
    const fileName = `${TEST_SESSION_ID}.jsonl`;
    const filePath = join(tmpRoot, fileName);
    const replacementPath = join(tmpRoot, 'replacement.tmp');
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher(
      { version: 1, watches: [watch] },
      join(tmpRoot, 'state.json'),
    );
    writeFileSync(filePath, original, 'utf8');

    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    writeFileSync(replacementPath, replacement, 'utf8');
    renameSync(replacementPath, filePath);
    (watcher as any).handleRootWatchEvent(tmpRoot, watch.path, watch, schema, fileName, 'rename');
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(expected);
  });

  it('detects changed atomic replacement content when startAtEnd is false', async () => {
    const fileName = `${TEST_SESSION_ID}.jsonl`;
    const filePath = join(tmpRoot, fileName);
    const replacementPath = join(tmpRoot, 'replacement.tmp');
    const original = entry('old content');
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: false,
    };
    const statePath = join(tmpRoot, 'state.json');
    writeFileSync(filePath, original, 'utf8');
    writeFileSync(statePath, JSON.stringify({ offsets: { [filePath]: Buffer.byteLength(original) } }), 'utf8');
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    writeFileSync(replacementPath, entry('new content'), 'utf8');
    renameSync(replacementPath, filePath);
    (watcher as any).handleRootWatchEvent(tmpRoot, watch.path, watch, schema, fileName, 'rename');
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['new content']);
  });

  it('continues from the original offset when Codex moves a session into the archive', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const fileName = `rollout-${sessionId}.jsonl`;
    const originalPath = join(tmpRoot, '.codex', 'sessions', '2026', '07', '12', fileName);
    const archivedPath = join(tmpRoot, '.codex', 'archived_sessions', fileName);
    const statePath = join(tmpRoot, 'state.json');
    const historicalEntry = `${JSON.stringify({
      type: 'event',
      payload: {
        type: 'user_message',
        session_id: sessionId,
        message: 'historical prompt that was already observed',
      },
    })}\n`;

    mkdirSync(join(originalPath, '..'), { recursive: true });
    mkdirSync(join(archivedPath, '..'), { recursive: true });
    writeFileSync(originalPath, historicalEntry, 'utf8');
    writeFileSync(archivedPath, historicalEntry, 'utf8');
    writeFileSync(statePath, JSON.stringify({ offsets: { [originalPath]: Buffer.byteLength(historicalEntry) + 100 } }), 'utf8');

    const schema: TranscriptSchema = {
      name: 'codex',
      events: [
        {
          name: 'user-message',
          match: { path: 'payload.type', equals: 'user_message' },
          action: 'session_init',
          fields: {
            sessionId: 'payload.session_id',
            prompt: 'payload.message',
          },
        },
      ],
    };
    const watch: WatchTarget = {
      name: 'codex-archived',
      path: join(tmpRoot, '.codex', 'archived_sessions', '*.jsonl'),
      schema,
      startAtEnd: false,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    await (watcher as any).addTailer(archivedPath, watch, schema);
    await waitForAsyncTail();

    expect(sessionInitCalls).toHaveLength(0);

    appendFileSync(
      archivedPath,
      `${JSON.stringify({
        type: 'event',
        payload: {
          type: 'user_message',
          session_id: sessionId,
          message: 'new prompt after archive',
        },
      })}\n`,
      'utf8',
    );

    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toEqual(['new prompt after archive']);
  });

  it('keeps the active Codex offset when an archive root event discovers the moved file', async () => {
    const fileName = `rollout-${TEST_SESSION_ID}.jsonl`;
    const activePath = join(tmpRoot, '.codex', 'sessions', '2026', '07', '12', fileName);
    const archiveRoot = join(tmpRoot, '.codex', 'archived_sessions');
    const archivedPath = join(archiveRoot, fileName);
    const statePath = join(tmpRoot, 'state.json');
    const history = entry('already processed while active');
    const archiveTail = entry('written before archive discovery');
    const codexSchema: TranscriptSchema = { ...schema, name: 'codex' };
    const watch: WatchTarget = {
      name: 'codex-archived',
      path: join(archiveRoot, '*.jsonl'),
      schema: codexSchema,
      startAtEnd: true,
    };

    mkdirSync(join(activePath, '..'), { recursive: true });
    mkdirSync(archiveRoot, { recursive: true });
    writeFileSync(activePath, history + archiveTail, 'utf8');
    writeFileSync(statePath, JSON.stringify({
      offsets: { [activePath]: Buffer.byteLength(history) },
    }), 'utf8');
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await watcher.start();

    renameSync(activePath, archivedPath);
    (watcher as any).handleRootWatchEvent(
      archiveRoot,
      watch.path,
      watch,
      codexSchema,
      fileName,
      'rename',
    );
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['written before archive discovery']);
  });

  it('keeps a saved archive offset but does not replay it after unarchive and rearchive', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const fileName = `rollout-${sessionId}.jsonl`;
    const archiveRoot = join(tmpRoot, '.codex', 'archived_sessions');
    const archivedPath = join(archiveRoot, fileName);
    const activePath = join(tmpRoot, '.codex', 'sessions', '2026', '07', '12', fileName);
    const statePath = join(tmpRoot, 'state.json');
    const entry = (message: string) => `${JSON.stringify({
      type: 'event',
      payload: { type: 'user_message', session_id: sessionId, message },
    })}\n`;
    const history = entry('history before archive');

    mkdirSync(archiveRoot, { recursive: true });
    mkdirSync(join(activePath, '..'), { recursive: true });
    writeFileSync(archivedPath, history + entry('history added while active'), 'utf8');
    writeFileSync(statePath, JSON.stringify({ offsets: { [archivedPath]: Buffer.byteLength(history) } }), 'utf8');

    const schema: TranscriptSchema = {
      name: 'codex',
      events: [{
        name: 'user-message',
        match: { path: 'payload.type', equals: 'user_message' },
        action: 'session_init',
        fields: { sessionId: 'payload.session_id', prompt: 'payload.message' },
      }],
    };
    const watch: WatchTarget = {
      name: 'codex-archived',
      path: join(archiveRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    const notify = (event = 'change') => (watcher as any).handleRootWatchEvent(
      archiveRoot,
      watch.path,
      watch,
      schema,
      fileName,
      event,
    );

    notify('rename');
    await waitForAsyncTail();
    const originalTailer = (watcher as any).tailers.get(archivedPath);
    appendFileSync(archivedPath, entry('live after first archive'));
    notify();
    await waitForAsyncTail();

    renameSync(archivedPath, activePath);
    notify('rename');
    await waitForAsyncTail();
    expect((watcher as any).tailers.has(archivedPath)).toBe(false);
    appendFileSync(activePath, entry('history added before rearchive'));
    renameSync(activePath, archivedPath);
    notify('rename');
    await waitForAsyncTail();
    expect((watcher as any).tailers.get(archivedPath)).not.toBe(originalTailer);
    appendFileSync(archivedPath, entry('live after rearchive'));
    notify();
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual([
      'history added while active',
      'live after first archive',
      'live after rearchive',
    ]);
  });

  it('does not let a closed old tailer replay a same-path rearchive', async () => {
    const fileName = `rollout-${TEST_SESSION_ID}.jsonl`;
    const archiveRoot = join(tmpRoot, '.codex', 'archived_sessions');
    const archivedPath = join(archiveRoot, fileName);
    const activePath = join(tmpRoot, '.codex', 'sessions', '2026', '07', '12', fileName);
    const watch: WatchTarget = {
      name: 'codex-archived',
      path: join(archiveRoot, '*.jsonl'),
      schema: { ...schema, name: 'codex' },
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher(
      { version: 1, watches: [watch] },
      join(tmpRoot, 'state.json'),
    );
    const processed: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>(resolve => { firstStarted = resolve; });
    (watcher as any).processor.processEntry = async (item: any) => {
      const message = item.payload.message;
      processed.push(message);
      if (message === 'live before removal') {
        firstStarted();
        await firstBlocked;
      }
    };

    mkdirSync(archiveRoot, { recursive: true });
    mkdirSync(join(activePath, '..'), { recursive: true });
    writeFileSync(archivedPath, entry('old archive history'), 'utf8');
    await (watcher as any).addTailer(archivedPath, watch, watch.schema);
    await waitForAsyncTail();
    const oldTailer = (watcher as any).tailers.get(archivedPath);

    appendFileSync(archivedPath, entry('live before removal'));
    oldTailer.poke();
    await firstEntered;
    renameSync(archivedPath, activePath);
    (watcher as any).handleRootWatchEvent(archiveRoot, watch.path, watch, watch.schema, fileName, 'rename');
    appendFileSync(activePath, entry('history while archive was absent'));
    renameSync(activePath, archivedPath);
    (watcher as any).handleRootWatchEvent(archiveRoot, watch.path, watch, watch.schema, fileName, 'rename');
    await waitForAsyncTail();

    oldTailer.poke();
    releaseFirst();
    await waitForAsyncTail();
    appendFileSync(archivedPath, entry('live after rearchive'));
    (watcher as any).handleRootWatchEvent(archiveRoot, watch.path, watch, watch.schema, fileName, 'change');
    await waitForAsyncTail();
    watcher.stop();

    expect(processed).toEqual(['live before removal', 'live after rearchive']);
  });

  it('does not deliver another line after stop closes an in-flight tailer', async () => {
    const filePath = join(tmpRoot, `${TEST_SESSION_ID}.jsonl`);
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher(
      { version: 1, watches: [watch] },
      join(tmpRoot, 'state.json'),
    );
    const processed: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>(resolve => { firstStarted = resolve; });
    (watcher as any).processor.processEntry = async (item: any) => {
      const message = item.payload.message;
      processed.push(message);
      if (message === 'first live line') {
        firstStarted();
        await firstBlocked;
      }
    };

    writeFileSync(filePath, entry('old history'), 'utf8');
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    appendFileSync(filePath, entry('first live line') + entry('must not run after stop'));
    (watcher as any).tailers.get(filePath).poke();
    await firstEntered;
    watcher.stop();
    releaseFirst();
    await waitForAsyncTail();

    expect(processed).toEqual(['first live line']);
  });

  it('persists only completed lines so restart recovers the blocked remainder', async () => {
    const filePath = join(tmpRoot, `${TEST_SESSION_ID}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const history = entry('old history');
    const first = entry('completed live line');
    const second = entry('blocked live line');
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const secondBlocked = new Promise<void>(resolve => { releaseSecond = resolve; });
    const secondEntered = new Promise<void>(resolve => { secondStarted = resolve; });
    (watcher as any).processor.processEntry = async (item: any) => {
      if (item.payload.message === 'blocked live line') {
        secondStarted();
        await secondBlocked;
      }
    };

    writeFileSync(filePath, history, 'utf8');
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    appendFileSync(filePath, first + second);
    (watcher as any).tailers.get(filePath).poke();
    await secondEntered;

    expect(JSON.parse(readFileSync(statePath, 'utf8')).offsets[filePath])
      .toBe(Buffer.byteLength(history + first));
    watcher.stop();
    releaseSecond();
    await waitForAsyncTail();

    const restarted = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (restarted as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    restarted.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['blocked live line']);
  });

  it('recovers a UTF-8 line split mid-character across restart', async () => {
    const filePath = join(tmpRoot, `${TEST_SESSION_ID}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const complete = Buffer.from(entry('中文半行'));
    const splitAt = complete.indexOf(Buffer.from('中')) + 1;
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: false,
    };
    writeFileSync(filePath, complete.subarray(0, splitAt));
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    watcher.stop();

    appendFileSync(filePath, complete.subarray(splitAt));
    const restarted = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (restarted as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    restarted.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['中文半行']);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).offsets[filePath]).toBe(complete.length);
  });

  it('rebuilds a failed root watcher and discovers files created while it was down', async () => {
    const filePath = join(tmpRoot, `${TEST_SESSION_ID}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await watcher.start();
    const failedRootWatcher = (watcher as any).rootWatchers[0];

    failedRootWatcher.emit('error', new Error('simulated root watcher failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((watcher as any).rootWatchers).not.toContain(failedRootWatcher);
    writeFileSync(filePath, entry('history created during root watcher outage'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 180));

    expect((watcher as any).rootWatchers).toHaveLength(1);
    expect((watcher as any).tailers.has(filePath)).toBe(true);
    appendFileSync(filePath, entry('live after root watcher recovery'));
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['live after root watcher recovery']);
  });

  it('records a per-file fs.watch creation failure and removes the missing tailer', async () => {
    const missingPath = join(tmpRoot, `${TEST_SESSION_ID}.jsonl`);
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: false,
    };
    const watcher = new TranscriptWatcher(
      { version: 1, watches: [watch] },
      join(tmpRoot, 'state.json'),
    );

    await (watcher as any).addTailer(missingPath, watch, schema);
    await waitForAsyncTail();
    watcher.stop();

    expect((watcher as any).tailers.has(missingPath)).toBe(false);
    expect(loggerSpies[2].mock.calls.some(call =>
      call[1] === 'Failed to watch transcript file; recursive watcher will retry it'
    )).toBe(true);
  });
});
