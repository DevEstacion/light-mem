import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const rawAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const cwd = r.cwd ?? r.workspaceRoot ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    return {
      sessionId: r.sessionId ?? r.session_id ?? 'unknown',
      cwd,
      prompt: r.prompt,
      toolName: r.toolName ?? r.tool_name,
      toolInput: r.toolInput ?? r.tool_input,
      // Grok PostToolUse: toolResult; Claude: tool_response; some hosts: toolOutput
      toolResponse: r.toolResponse ?? r.tool_response ?? r.toolResult ?? r.tool_result ?? r.toolOutput,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path ?? r.target_file ?? r.path,
      edits: r.edits,
    };
  },
  formatOutput(result) {
    return result;
  }
};
