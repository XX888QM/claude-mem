import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { isClaudeShadowOfCursor } from '../../src/shared/cursor-claude-shadow.js';

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
  });
});
