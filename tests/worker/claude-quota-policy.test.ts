import { expect, test, spyOn } from 'bun:test';
import * as atomicJson from '../../src/shared/atomic-json.js';
import { isClaudeSubscriptionDisallowed } from '../../src/services/worker/claude-quota-policy.js';

function withOverride(value: string | undefined, run: () => void): void {
  const previous = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  if (value === undefined) delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  else process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
    else process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = previous;
  }
}

test('env true blocks Claude subscription use', () => {
  withOverride('true', () => {
    expect(isClaudeSubscriptionDisallowed()).toBe(true);
  });
});

test('env false is the test escape even when settings disallow it', () => {
  withOverride('false', () => {
    expect(isClaudeSubscriptionDisallowed()).toBe(false);
  });
});

test('missing, malformed and unspecified settings cannot enable Claude quota', () => {
  withOverride(undefined, () => {
    const read = spyOn(atomicJson, 'readJsonFileWithBom');
    try {
      read.mockImplementation(() => { throw new Error('unreadable'); });
      expect(isClaudeSubscriptionDisallowed()).toBe(true);
      for (const value of [null, [], {}, Object.create({ CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA: 'false' }), { env: { CLAUDE_MEM_PROVIDER: 'grok' } }]) {
        read.mockReturnValue(value);
        expect(isClaudeSubscriptionDisallowed()).toBe(true);
      }
      read.mockReturnValue({ env: { CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA: 'false' } });
      expect(isClaudeSubscriptionDisallowed()).toBe(false);
    } finally { read.mockRestore(); }
  });
});
