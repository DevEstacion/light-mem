export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  // PostToolBatch (Claude Code) delivers a whole batch of resolved tool calls in
  // one event instead of one PostToolUse per tool. Each entry mirrors the
  // single-tool fields; toolResponse here is the serialized tool_result content
  // the model saw (a string/content-block), not PostToolUse's structured Output.
  toolCalls?: Array<{ toolName?: string; toolInput?: unknown; toolResponse?: unknown; toolUseId?: string }>;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  turnId?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  model?: string;
  sessionSource?: 'startup' | 'resume' | 'clear';
  filePath?: string;   
  edits?: unknown[];   
  metadata?: Record<string, unknown>;
  agentId?: string;      
  agentType?: string;    
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
  systemMessage?: string;
  decision?: 'block' | 'approve';
  reason?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}
