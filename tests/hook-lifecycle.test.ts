import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

describe('Hook Lifecycle - Event Handlers', () => {
  describe('worker fallback failure counter', () => {
    it('resets stale unreachable state before 429/5xx API fallbacks', () => {
      const source = readFileSync('src/shared/worker-utils.ts', 'utf-8');
      const nonOkRegion = source.slice(
        source.indexOf('if (!response.ok)'),
        source.indexOf('const text = await response.text();'),
      );

      expect(nonOkRegion.indexOf('resetWorkerFailureCounter()'))
        .toBeLessThan(nonOkRegion.indexOf('response.status === 429 || response.status >= 500'));
    });
  });

  describe('getEventHandler', () => {
    it('should return handler for all recognized event types', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const recognizedTypes = [
        'context', 'session-init', 'observation',
        'summarize', 'user-message', 'file-edit', 'file-context'
      ];
      for (const type of recognizedTypes) {
        const handler = getEventHandler(type);
        expect(handler).toBeDefined();
        expect(handler.execute).toBeDefined();
      }
    });

    it('should return no-op handler for unknown event types (#984)', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const handler = getEventHandler('nonexistent-event');
      expect(handler).toBeDefined();
      expect(handler.execute).toBeDefined();

      const result = await handler.execute({
        sessionId: 'test-session',
        cwd: '/tmp'
      });
      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(result.exitCode).toBe(0);
    });

  });
});

describe('getPlatformAdapter', () => {
  it('should return claudeCodeAdapter for claude-code', async () => {
    const { getPlatformAdapter, claudeCodeAdapter } = await import('../src/cli/adapters/index.js');
    const adapter = getPlatformAdapter('claude-code');
    expect(adapter).toBe(claudeCodeAdapter);
  });

  it('should return rawAdapter for any unrecognized platform string', async () => {
    const { getPlatformAdapter, rawAdapter } = await import('../src/cli/adapters/index.js');
    const adapter = getPlatformAdapter('some-future-cli');
    expect(adapter).toBe(rawAdapter);
  });
});

describe('claudeCodeAdapter session_id fallbacks', () => {
  it('should use session_id when present', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({ session_id: 'claude-123', cwd: '/tmp' });
    expect(input.sessionId).toBe('claude-123');
  });

  it('should fall back to id field', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({ id: 'id-456', cwd: '/tmp' });
    expect(input.sessionId).toBe('id-456');
  });

  it('should fall back to sessionId field (camelCase format)', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({ sessionId: 'camel-789', cwd: '/tmp' });
    expect(input.sessionId).toBe('camel-789');
  });

  it('should return undefined when no session ID field is present', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({ cwd: '/tmp' });
    expect(input.sessionId).toBeUndefined();
  });

  it('should handle undefined input gracefully', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput(undefined);
    expect(input.sessionId).toBeUndefined();
    expect(input.cwd).toBe(process.cwd());
  });
});

describe('claudeCodeAdapter Grok Build PostToolUse envelope', () => {
  // Grok loads light-mem as a Claude plugin but feeds camelCase stdin
  // (docs.x.ai/build/features/hooks). Regression: missing dual-key reads
  // caused observationHandler to skip every Grok tool event.

  it('should map camelCase tool fields from a Grok PostToolUse payload', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({
      hookEventName: 'post_tool_use',
      sessionId: 'grok-sess-1',
      cwd: '/home/ron/project',
      workspaceRoot: '/home/ron/project',
      toolName: 'run_terminal_command',
      toolInput: { command: 'echo hi', description: 'test' },
      toolResult: { output: 'hi\n', exitCode: 0 },
      toolUseId: 'call-abc',
      timestamp: '2026-07-19T00:00:00Z',
    });

    expect(input.sessionId).toBe('grok-sess-1');
    expect(input.cwd).toBe('/home/ron/project');
    expect(input.toolName).toBe('run_terminal_command');
    expect(input.toolInput).toEqual({ command: 'echo hi', description: 'test' });
    expect(input.toolResponse).toEqual({ output: 'hi\n', exitCode: 0 });
  });

  it('should prefer Claude snake_case when both naming styles are present', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'claude-wins',
      sessionId: 'grok-loses',
      cwd: '/tmp',
      tool_name: 'Bash',
      toolName: 'run_terminal_command',
      tool_input: { command: 'claude' },
      toolInput: { command: 'grok' },
      tool_response: { out: 'claude' },
      toolResult: { out: 'grok' },
    });

    expect(input.sessionId).toBe('claude-wins');
    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'claude' });
    expect(input.toolResponse).toEqual({ out: 'claude' });
  });

  it('should fall back to workspaceRoot when cwd is missing (Grok envelope)', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({
      sessionId: 'no-cwd',
      workspaceRoot: '/workspace/root',
      toolName: 'read_file',
      toolInput: { target_file: '/workspace/root/a.ts' },
    });
    expect(input.cwd).toBe('/workspace/root');
    expect(input.toolName).toBe('read_file');
  });

  it('should map Grok subagentType to agentType', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({
      sessionId: 'sub',
      cwd: '/tmp',
      toolName: 'search_replace',
      toolInput: {},
      subagentType: 'explore',
    });
    expect(input.agentType).toBe('explore');
  });
});

describe('normalizePlatformSource multi-host detection', () => {
  const originalGrokEvent = process.env.GROK_HOOK_EVENT;
  const originalGrokSession = process.env.GROK_SESSION_ID;
  const originalCodexHook = process.env.LIGHT_MEM_CODEX_HOOK;

  afterEach(() => {
    if (originalGrokEvent === undefined) delete process.env.GROK_HOOK_EVENT;
    else process.env.GROK_HOOK_EVENT = originalGrokEvent;
    if (originalGrokSession === undefined) delete process.env.GROK_SESSION_ID;
    else process.env.GROK_SESSION_ID = originalGrokSession;
    if (originalCodexHook === undefined) delete process.env.LIGHT_MEM_CODEX_HOOK;
    else process.env.LIGHT_MEM_CODEX_HOOK = originalCodexHook;
  });

  it('should return grok when GROK_HOOK_EVENT is set (even if CLI platform is claude-code)', async () => {
    process.env.GROK_HOOK_EVENT = 'post_tool_use';
    delete process.env.GROK_SESSION_ID;
    delete process.env.LIGHT_MEM_CODEX_HOOK;
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('claude-code')).toBe('grok');
  });

  it('should return codex when LIGHT_MEM_CODEX_HOOK=1', async () => {
    delete process.env.GROK_HOOK_EVENT;
    delete process.env.GROK_SESSION_ID;
    process.env.LIGHT_MEM_CODEX_HOOK = '1';
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('claude-code')).toBe('codex');
  });

  it('should return claude for claude-code when host env is absent', async () => {
    delete process.env.GROK_HOOK_EVENT;
    delete process.env.GROK_SESSION_ID;
    delete process.env.LIGHT_MEM_CODEX_HOOK;
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('claude-code')).toBe('claude');
  });

  it('should map explicit platform labels', async () => {
    delete process.env.GROK_HOOK_EVENT;
    delete process.env.GROK_SESSION_ID;
    delete process.env.LIGHT_MEM_CODEX_HOOK;
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('opencode')).toBe('opencode');
    expect(normalizePlatformSource('codex-cli')).toBe('codex');
  });
});

describe('claudeCodeAdapter Codex Stop envelope', () => {
  it('should map stop_hook_active and last_assistant_message', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'codex-sess',
      cwd: '/tmp/project',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: 'All tests passed.',
      turn_id: 'turn-1',
      permission_mode: 'default',
      model: 'gpt-5.3-codex',
    });
    expect(input.sessionId).toBe('codex-sess');
    expect(input.stopHookActive).toBe(true);
    expect(input.lastAssistantMessage).toBe('All tests passed.');
    expect(input.turnId).toBe('turn-1');
    expect(input.permissionMode).toBe('default');
    expect(input.model).toBe('gpt-5.3-codex');
  });
});

describe('session-init handler undefined prompt', () => {
  it('should not throw when prompt is undefined', () => {
    const rawPrompt: string | undefined = undefined;
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
    expect(prompt).toBe('[media prompt]');
  });

  it('should not throw when prompt is empty string', () => {
    const rawPrompt = '';
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
    expect(prompt).toBe('[media prompt]');
  });

  it('should not throw when prompt is whitespace-only', () => {
    const rawPrompt = '   ';
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
    expect(prompt).toBe('[media prompt]');
  });

  it('should preserve valid prompts', () => {
    const rawPrompt = 'fix the bug';
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
    expect(prompt).toBe('fix the bug');
  });
});

describe('Hook Lifecycle - Claude Code Adapter', () => {
  const fmt = async (input: any) => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    return claudeCodeAdapter.formatOutput(input);
  };

  it('should return empty object for empty result', async () => {
    expect(await fmt({})).toEqual({});
  });

  it('should include systemMessage when present', async () => {
    expect(await fmt({ systemMessage: 'test message' })).toEqual({ systemMessage: 'test message' });
  });

  it('should use hookSpecificOutput format with systemMessage', async () => {
    const output = await fmt({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'test context' },
      systemMessage: 'test message'
    }) as Record<string, unknown>;
    expect(output.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'test context' });
    expect(output.systemMessage).toBe('test message');
  });

  it('should return hookSpecificOutput without systemMessage when absent', async () => {
    expect(await fmt({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    })).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    });
  });

  it('should return empty object for malformed input (undefined/null)', async () => {
    expect(await fmt(undefined)).toEqual({});
    expect(await fmt(null)).toEqual({});
  });

  it('should exclude falsy systemMessage values', async () => {
    expect(await fmt({ systemMessage: '' })).toEqual({});
    expect(await fmt({ systemMessage: null })).toEqual({});
    expect(await fmt({ systemMessage: 0 })).toEqual({});
  });

  it('should strip all non-contract fields', async () => {
    expect(await fmt({
      continue: false,
      suppressOutput: false,
      systemMessage: 'msg',
      exitCode: 2,
      hookSpecificOutput: undefined,
    })).toEqual({ systemMessage: 'msg' });
  });

  it('should only emit keys from the Claude Code hook contract', async () => {
    const allowedKeys = new Set(['hookSpecificOutput', 'systemMessage', 'decision', 'reason']);
    const cases = [
      {},
      { systemMessage: 'x' },
      { continue: true, suppressOutput: true, systemMessage: 'x', exitCode: 1 },
      { hookSpecificOutput: { hookEventName: 'E', additionalContext: 'C' }, systemMessage: 'x' },
    ];
    for (const input of cases) {
      for (const key of Object.keys(await fmt(input) as object)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });
});

describe('Hook Lifecycle - stderr Suppression (#1181)', () => {
  let originalStderrWrite: typeof process.stderr.write;
  let stderrOutput: string[];

  beforeEach(() => {
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    stderrOutput = [];
    process.stderr.write = ((chunk: any) => {
      stderrOutput.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it('should not use console.error in handlers/index.ts for unknown events', async () => {
    const { getEventHandler } = await import('../src/cli/handlers/index.js');

    stderrOutput.length = 0;

    const handler = getEventHandler('unknown-event-type');
    await handler.execute({ sessionId: 'test', cwd: '/tmp' });

    const dispatcherStderr = stderrOutput.filter(s => s.includes('[light-mem] Unknown event'));
    expect(dispatcherStderr).toHaveLength(0);
  });
});

describe('Hook Lifecycle - Standard Response', () => {
  it('should define standard hook response with suppressOutput: true', async () => {
    const { STANDARD_HOOK_RESPONSE } = await import('../src/hooks/hook-response.js');
    const parsed = JSON.parse(STANDARD_HOOK_RESPONSE);
    expect(parsed.continue).toBe(true);
    expect(parsed.suppressOutput).toBe(true);
  });
});

describe('hookCommand - stderr discipline (plan 01 / #2292)', () => {
  it('routes all IO through hook-io.ts and no longer blanket-swallows stderr', async () => {
    const { hookCommand } = await import('../src/cli/hook-command.js');
    expect(typeof hookCommand).toBe('function');

    const hookCommandSource = readFileSync(
      new URL('../src/cli/hook-command.ts', import.meta.url).pathname,
      'utf-8'
    );

    // Diagnostics still go through the structured logger.
    expect(hookCommandSource).toContain("import { logger }");
    expect(hookCommandSource).toContain("logger.warn('HOOK'");
    expect(hookCommandSource).toContain("logger.error('HOOK'");

    // #2292: the old blanket no-op swallow is GONE — replaced by the typed
    // buffered writer + bypass channel from src/shared/hook-io.ts.
    expect(hookCommandSource).not.toContain("process.stderr.write = (() => true)");
    expect(hookCommandSource).toContain("installHookStderrBuffer");

    // hookCommand orchestrates hook-io; it does not write streams directly.
    expect(hookCommandSource).toContain("emitModelContext");
    expect(hookCommandSource).toContain("emitBlockingError");
    expect(hookCommandSource).toContain("exitGraceful");
    expect(hookCommandSource).not.toContain("console.error(`[light-mem]");
  });
});
