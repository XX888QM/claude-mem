import { expect, it } from 'bun:test';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

it('blocks both Claude send entry points and Claude fallback configuration when quota is disabled', async () => {
  const previous = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = 'true';
  try {
    const provider = new ClaudeProvider({} as any, {} as any);
    await expect(provider.startSession({} as any)).rejects.toThrow('Claude subscription quota is disabled');
    await expect((provider as any).runStandaloneObserverPrompt('test', {}, 'test', '/not-used')).rejects.toThrow('Claude subscription quota is disabled');
    const validation = (new SettingsRoutes({} as any) as any).validateSettings({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude' });
    expect(validation.valid).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
    else process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA = previous;
  }
});
