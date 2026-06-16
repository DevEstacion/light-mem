import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

const { dataDir, workerCallLog } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  return {
    dataDir: path.join(os.tmpdir(), 'light-mem-file-edit-observer-test'),
    workerCallLog: [] as Array<{ path: string; method: string; body: unknown }>,
  };
});

vi.mock('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'LIGHT_MEM_DATA_DIR') return dataDir;
      return '';
    },
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
    throw new Error(`worker must not be called for internal observer sessions: ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
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
  loggerSpies.forEach(spy => spy.mockRestore());
});

describe('fileEditHandler internal observer sessions', () => {
  it('skips file edit observations before calling the worker', async () => {
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute({
      sessionId: 'observer-session-file-edit',
      cwd: OBSERVER_SESSIONS_DIR,
      platform: 'claude-code',
      filePath: join(OBSERVER_SESSIONS_DIR, 'transcript.jsonl'),
      edits: [{ oldText: 'before', newText: 'after' }],
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog).toEqual([]);
  });
});
