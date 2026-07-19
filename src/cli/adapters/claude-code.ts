import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

/**
 * Normalize Claude Code + Grok Build (+ Cursor-compat) hook envelopes.
 *
 * Claude Code sends snake_case (`tool_name`, `tool_input`, `tool_response`).
 * Grok Build loads Claude plugins but feeds camelCase stdin
 * (`toolName`, `toolInput`, `toolResult`) per docs.x.ai/build/features/hooks
 * and the Grok open-source hook contract. Without dual-key reads, PostToolUse
 * observations silently no-op under Grok (toolName is undefined → skip).
 */
export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const cwd = r.cwd ?? r.workspaceRoot ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd,
      prompt: r.prompt,
      // Claude snake_case first, then Grok/Cursor camelCase.
      toolName: r.tool_name ?? r.toolName,
      toolInput: r.tool_input ?? r.toolInput,
      // Grok PostToolUse uses `toolResult` (not tool_response / toolOutput).
      toolResponse: r.tool_response ?? r.toolResponse ?? r.tool_result ?? r.toolResult,
      transcriptPath: r.transcript_path ?? r.transcriptPath,
      agentId: pickAgentField(r.agent_id ?? r.agentId),
      agentType: pickAgentField(r.agent_type ?? r.agentType ?? r.subagentType),
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
