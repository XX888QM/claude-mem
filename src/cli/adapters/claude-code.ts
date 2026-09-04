import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    // Real Claude Code always sends `cwd` on every hook event; falling back to
    // process.cwd() here let non-Claude-Code callers (e.g. Cursor's Claude Code
    // hook-compatibility shim invoking these scripts without a real cwd) slip
    // through with cwd = wherever the script happened to be run from, landing
    // sessions under a bogus project name (a claude-mem version/hash string).
    const cwd = r.cwd;
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
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
