import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { isClaudeShadowOfCursor, resolveSummarizeTargetSessionDbId } from '../../src/shared/cursor-claude-shadow.js';

describe('Cursor Claude shadow sessions', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('detects a cursor twin for the same content session', () => {
    const contentSessionId = 'b4e86952-01a0-4386-8c32-3367746aefed';
    store.createSDKSession(contentSessionId, 'iOS水印相机', 'prompt', undefined, 'cursor');

    expect(store.hasSDKSession(contentSessionId, 'cursor')).toBe(true);
    expect(store.hasSDKSession(contentSessionId, 'claude')).toBe(false);
    expect(isClaudeShadowOfCursor('claude-code', true)).toBe(true);
    expect(isClaudeShadowOfCursor('cursor', true)).toBe(false);
    expect(store.getSDKSessionId(contentSessionId, 'cursor')).toBeGreaterThan(0);
    expect(store.getSDKSessionId(contentSessionId, 'claude')).toBeNull();
  });

  it('routes Claude-compat summarize onto the existing Cursor session', () => {
    const contentSessionId = '13e1243c-35d3-4e4a-81ef-1ccaa7086d7a';
    const cursorId = store.createSDKSession(contentSessionId, 'claude-mem', 'prompt', undefined, 'cursor');
    let createdOwn = 0;
    const routed = resolveSummarizeTargetSessionDbId(
      'claude',
      store.getSDKSessionId(contentSessionId, 'cursor'),
      () => {
        createdOwn += 1;
        return store.createSDKSession(contentSessionId, 'claude-mem', 'prompt', undefined, 'claude');
      },
    );
    expect(routed).toEqual({ sessionDbId: cursorId, reusedCursorTwin: true });
    expect(createdOwn).toBe(0);
    expect(store.hasSDKSession(contentSessionId, 'claude')).toBe(false);
  });

  it('keeps a native Cursor summarize on the Cursor session', () => {
    const contentSessionId = '321634c4-fd77-4c37-b7bf-c67ea07aaf46';
    const cursorId = store.createSDKSession(contentSessionId, '做市PM', 'prompt', undefined, 'cursor');
    let ownCalled = 0;
    const routed = resolveSummarizeTargetSessionDbId(
      'cursor',
      cursorId,
      () => {
        ownCalled += 1;
        return cursorId;
      },
    );
    expect(routed).toEqual({ sessionDbId: cursorId, reusedCursorTwin: false });
    expect(ownCalled).toBe(1);
  });

  it('creates own session when no cursor twin exists', () => {
    let called = 0;
    const routed = resolveSummarizeTargetSessionDbId('claude', null, () => {
      called += 1;
      return 99;
    });
    expect(routed).toEqual({ sessionDbId: 99, reusedCursorTwin: false });
    expect(called).toBe(1);
  });
});
