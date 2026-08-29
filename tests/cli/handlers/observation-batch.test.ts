import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { workerCallLog } = vi.hoisted(() => ({
  workerCallLog: [] as Array<{ path: string; method: string; body: any }>,
}));

vi.mock('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({ LIGHT_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

vi.mock('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ LIGHT_MEM_EXCLUDED_PROJECTS: '' }),
}));

vi.mock('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    return { status: 'queued' };
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  loggerSpies = [
    vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    vi.spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach((spy) => spy.mockRestore());
});

describe('observationBatchHandler', () => {
  it('posts one worker observation per tool call, matching the single-tool payload shape', async () => {
    const { observationBatchHandler } = await import('../../../src/cli/handlers/observation-batch.js');

    const result = await observationBatchHandler.execute({
      sessionId: 'batch-sess-1',
      cwd: '/home/ron/project',
      platform: 'claude-code',
      agentId: 'agent-9',
      agentType: 'general',
      toolCalls: [
        { toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolResponse: '1\tcontent', toolUseId: 'call-1' },
        { toolName: 'Bash', toolInput: { command: 'ls' }, toolResponse: 'a\nb\n', toolUseId: 'call-2' },
      ],
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(2);

    // Payload keys must mirror the single-tool observationHandler (plus tool_use_id).
    const expectedKeys = [
      'agentId', 'agentType', 'contentSessionId', 'cwd',
      'platformSource', 'tool_input', 'tool_name', 'tool_response', 'tool_use_id',
    ].sort();
    for (const call of workerCallLog) {
      expect(call.path).toBe('/api/sessions/observations');
      expect(call.method).toBe('POST');
      expect(Object.keys(call.body).sort()).toEqual(expectedKeys);
    }

    expect(workerCallLog[0].body).toMatchObject({
      contentSessionId: 'batch-sess-1',
      platformSource: 'claude',
      tool_name: 'Read',
      tool_input: { file_path: '/a.ts' },
      tool_response: '1\tcontent',
      cwd: '/home/ron/project',
      agentId: 'agent-9',
      agentType: 'general',
      tool_use_id: 'call-1',
    });
    expect(workerCallLog[1].body.tool_name).toBe('Bash');
  });

  it('accepts a PostToolBatch envelope serialized tool_response (string) unchanged', async () => {
    const { observationBatchHandler } = await import('../../../src/cli/handlers/observation-batch.js');
    await observationBatchHandler.execute({
      sessionId: 's',
      cwd: '/home/ron/project',
      platform: 'claude-code',
      toolCalls: [{ toolName: 'Read', toolInput: {}, toolResponse: 'serialized-content-block-string' }],
    });
    expect(workerCallLog[0].body.tool_response).toBe('serialized-content-block-string');
  });

  it('no-ops when there are no tool calls', async () => {
    const { observationBatchHandler } = await import('../../../src/cli/handlers/observation-batch.js');
    const result = await observationBatchHandler.execute({ sessionId: 's', cwd: '/home/ron/project', toolCalls: [] });
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog).toHaveLength(0);
  });

  it('skips tool calls without a toolName', async () => {
    const { observationBatchHandler } = await import('../../../src/cli/handlers/observation-batch.js');
    await observationBatchHandler.execute({
      sessionId: 's',
      cwd: '/home/ron/project',
      platform: 'claude-code',
      toolCalls: [{ toolInput: {} }, { toolName: 'Read', toolInput: {} }],
    });
    expect(workerCallLog).toHaveLength(1);
    expect(workerCallLog[0].body.tool_name).toBe('Read');
  });
});
