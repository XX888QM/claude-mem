import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { settingsTarget, type SettingsDocument } from '../../shared/settings-document.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/** This fork must not spend the Claude subscription. Env `false` is the test escape. */
export function isClaudeSubscriptionDisallowed(): boolean {
  const override = process.env.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA;
  if (override === 'false') return false;
  if (override === 'true') return true;
  try {
    // Do not use a defaults reader that can turn a corrupt file into "false".
    const document = readJsonFileWithBom<unknown>(USER_SETTINGS_PATH);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return true;
    const target = settingsTarget(document as SettingsDocument);
    return !Object.hasOwn(target, 'CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA') || target.CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA !== 'false';
  } catch {
    return true;
  }
}

export const CLAUDE_QUOTA_DISABLED_MESSAGE =
  'Claude subscription quota is disabled. Observation and summary stay on Grok or Codex; use get_corpus instead of priming a Claude session.';
