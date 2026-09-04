import path from 'path';
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const cwd = r.cwd ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    // Claude Code sets CLAUDE_PLUGIN_ROOT to this plugin's own install directory
    // when invoking its hooks. A real project session's cwd is never inside that
    // directory — the only way to land there is a caller with no real cwd that
    // also spawned us with our own install path as its process cwd (observed:
    // Cursor's Claude Code hook-compatibility layer, invoking `hook claude-code
    // <event>` for ordinary Cursor prompts). Reject that specific case instead
    // of the general "no cwd" one, which the process.cwd() fallback above still
    // needs to handle gracefully for other loosely-compatible callers (#744).
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
    if (pluginRoot && (cwd === pluginRoot || cwd.startsWith(pluginRoot + path.sep))) {
      throw new AdapterRejectedInput('cwd_inside_plugin_root');
    }
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd,
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
      agentId: pickAgentField(r.agent_id),
      agentType: pickAgentField(r.agent_type),
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    if (r.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (r.systemMessage) {
        output.systemMessage = r.systemMessage;
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    if (r.systemMessage) {
      output.systemMessage = r.systemMessage;
    }
    return output;
  }
};
