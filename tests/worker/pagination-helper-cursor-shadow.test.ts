import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';

describe('PaginationHelper hides Claude shadows of Cursor sessions', () => {
  let store: SessionStore;
  let helper: PaginationHelper;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    helper = new PaginationHelper({ getSessionStore: () => store } as any);
  });

  afterEach(() => {
    store.close();
  });

  it('keeps the cursor observation and drops the claude twin by default', () => {
    const contentSessionId = 'shared-session';
    const cursorId = store.createSDKSession(contentSessionId, 'iOS水印相机', 'p', undefined, 'cursor');
    const claudeId = store.createSDKSession(contentSessionId, 'iOS水印相机', 'p', undefined, 'claude');
    store.updateMemorySessionId(cursorId, 'mem-cursor');
    store.updateMemorySessionId(claudeId, 'mem-claude');

    const now = Date.now();
    store.storeObservation('mem-cursor', 'iOS水印相机', {
      type: 'change',
      title: '相册批量工具条按钮缩小',
      subtitle: '',
      facts: [],
      narrative: 'cursor',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1, 0, now);
    store.storeObservation('mem-claude', 'iOS水印相机', {
      type: 'change',
      title: '相册批量工具条按钮缩小',
      subtitle: '',
      facts: [],
      narrative: 'claude',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1, 0, now + 1000);

    const all = helper.getObservations(0, 10);
    expect(all.items.map(item => item.platform_source)).toEqual(['cursor']);

    const claudeOnly = helper.getObservations(0, 10, undefined, 'claude');
    expect(claudeOnly.items.map(item => item.platform_source)).toEqual(['claude']);
  });
});
