import { expect, it } from 'bun:test';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

it('rejects Grok effort values the CLI cannot execute', () => {
  const routes = new SettingsRoutes({} as any) as any;
  for (const effort of ['low', 'medium', 'high']) {
    expect(routes.validateSettings({ CLAUDE_MEM_GROK_REASONING_EFFORT: effort }).valid).toBe(true);
  }
  for (const effort of ['definitely-invalid', 'none', 'xhigh']) {
    expect(routes.validateSettings({ CLAUDE_MEM_GROK_REASONING_EFFORT: effort }).valid).toBe(false);
  }
});
