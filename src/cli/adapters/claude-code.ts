import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

/**
 * Normalize Claude Code + Codex CLI + Grok Build (+ Cursor-compat) hook envelopes.
 *
 * - Claude Code / Codex: snake_case (`tool_name`, `tool_input`, `tool_response`,
 *   `stop_hook_active`, `last_assistant_message`) — see learn.chatgpt.com/docs/hooks
 *   and Claude Code's hook contract.
 * - Grok Build: loads Claude plugins but feeds camelCase stdin
 *   (`toolName`, `toolInput`, `toolResult`) per docs.x.ai/build/features/hooks.
 *   Without dual-key reads, PostToolUse observations silently no-op under Grok.
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
      // Claude/Codex snake_case first, then Grok/Cursor camelCase.
      toolName: r.tool_name ?? r.toolName,
      toolInput: r.tool_input ?? r.toolInput,
      // Grok PostToolUse uses `toolResult`; Claude/Codex use `tool_response`.
      toolResponse: r.tool_response ?? r.toolResponse ?? r.tool_result ?? r.toolResult,
      transcriptPath: r.transcript_path ?? r.transcriptPath,
      // Codex Stop re-entry + last message (learn.chatgpt.com/docs/hooks §Stop).
      stopHookActive: r.stop_hook_active ?? r.stopHookActive,
      lastAssistantMessage: r.last_assistant_message ?? r.lastAssistantMessage,
      turnId: r.turn_id ?? r.turnId,
      permissionMode: r.permission_mode ?? r.permissionMode,
      model: r.model,
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
