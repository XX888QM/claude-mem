import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/** This fork must not spend the Claude subscription. Env `false` is the test escape. */
export function isClaudeSubscriptionDisallowed(): boolean {
  const override = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  if (override === 'false') return false;
  if (override === 'true') return true;
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA === 'true';
  } catch {
    return false;
  }
}

export const CLAUDE_QUOTA_DISABLED_MESSAGE =
  'Claude subscription quota is disabled. Observation and summary stay on Grok or Codex; use get_corpus instead of priming a Claude session.';
