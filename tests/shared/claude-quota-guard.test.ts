import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { canClaudeServeAsFallback, claudeQuotaStandIn } from '../../src/shared/claude-fallback-readiness.js';
import { isClaudeSubscriptionDisallowed } from '../../src/services/worker/claude-quota-policy.js';

describe('fork policy: Claude subscription quota is never spent', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA; process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA; else process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = saved; });

  it('reports the ban', () => expect(isClaudeSubscriptionDisallowed()).toBe(true));
  it('never offers a quota stand-in credential', () => expect(claudeQuotaStandIn()).toBeNull());
  it('never lets Claude serve as a fallback provider', () => expect(canClaudeServeAsFallback()).toBe(false));
});
