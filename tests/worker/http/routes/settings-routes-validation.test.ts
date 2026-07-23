import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes summary provider validation', () => {
  it('accepts the Grok summary provider implemented by GrokProvider', () => {
    const routes = new SettingsRoutes({} as never);
    expect((routes as any).validateSettings({ CLAUDE_MEM_SUMMARY_PROVIDER: 'grok' })).toEqual({ valid: true });
  });

  it('accepts none for Codex observer reasoning', () => {
    const routes = new SettingsRoutes({} as never);
    expect((routes as any).validateSettings({ CLAUDE_MEM_CODEX_REASONING_EFFORT: 'none' })).toEqual({ valid: true });
  });
});
