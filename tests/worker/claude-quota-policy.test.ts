import { expect, test } from 'bun:test';
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
