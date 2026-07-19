import { describe, it, expect } from 'vitest';
import { mergeCodexHooks } from '../../src/services/integrations/CodexInstaller.js';

describe('CodexInstaller.mergeCodexHooks', () => {
  const lightMem = {
    description: 'light-mem memory system hooks (Codex CLI)',
    hooks: {
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "$_P/scripts/node-runner.js" "$_P/scripts/worker-service.cjs" hook claude-code observation',
              timeout: 120,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "$_P/scripts/node-runner.js" "$_P/scripts/worker-service.cjs" hook claude-code summarize',
              timeout: 120,
            },
          ],
        },
      ],
    },
  };

  it('installs light-mem hooks into an empty config', () => {
    const merged = mergeCodexHooks(null, lightMem);
    expect(merged.hooks?.PostToolUse).toHaveLength(1);
    expect(merged.hooks?.Stop).toHaveLength(1);
    expect(merged.description).toContain('light-mem');
  });

  it('preserves user hooks while replacing prior light-mem groups', () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
          {
            hooks: [
              {
                type: 'command',
                command: 'old node "$_P/scripts/worker-service.cjs" hook claude-code observation',
              },
            ],
          },
        ],
      },
    };

    const merged = mergeCodexHooks(existing, lightMem);
    const post = merged.hooks!.PostToolUse!;
    expect(post).toHaveLength(2);
    expect(post[0].hooks?.[0].command).toBe('echo user-hook');
    expect(post[1].hooks?.[0].command).toContain('observation');
    // Only one light-mem group remains (old replaced).
    const lightMemCount = post.filter((g) =>
      (g.hooks ?? []).some((h) => String(h.command).includes('worker-service.cjs')),
    ).length;
    expect(lightMemCount).toBe(1);
  });
});
