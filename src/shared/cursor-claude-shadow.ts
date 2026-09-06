import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from './platform-source.js';

export const CURSOR_SHADOW_REASON = 'cursor_compat_duplicate';

export function isClaudeShadowOfCursor(
  platformSource: string | undefined | null,
  hasCursorTwin: boolean,
): boolean {
  return normalizePlatformSource(platformSource) === 'claude' && hasCursorTwin;
}

export function looksLikeCursorNativeHookPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.conversation_id === 'string' && r.conversation_id.length > 0) return true;
  if (typeof r.generation_id === 'string' && r.generation_id.length > 0) return true;
  return Array.isArray(r.workspace_roots) && r.workspace_roots.length > 0;
}

export function cursorShadowClaudeExcludeSql(sessionAlias = 's'): string {
  return `
    NOT (
      COALESCE(NULLIF(${sessionAlias}.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = 'claude'
      AND ${sessionAlias}.content_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sdk_sessions cursor_twin
        WHERE cursor_twin.content_session_id = ${sessionAlias}.content_session_id
          AND COALESCE(NULLIF(cursor_twin.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = 'cursor'
      )
    )
  `;
}
