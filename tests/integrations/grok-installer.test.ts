import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { fakeHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return { fakeHome: fs.mkdtempSync(require('path').join(os.tmpdir(), 'cm-grok-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('GrokInstaller', () => {
  it('installs the PostToolUse observation hook into ~/.grok/hooks/light-mem.json', async () => {
    const { installGrokIntegration, getGrokHooksPath } = await import(
      '../../src/services/integrations/GrokInstaller.js'
    );

    // Reads the generated plugin/hooks/grok-hooks.json from the repo cwd.
    const code = installGrokIntegration();
    expect(code).toBe(0);

    const hooksPath = getGrokHooksPath();
    expect(hooksPath).toBe(join(fakeHome, '.grok', 'hooks', 'light-mem.json'));
    expect(existsSync(hooksPath)).toBe(true);

    const doc = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    expect(doc.hooks.PostToolUse).toBeDefined();
    const command = doc.hooks.PostToolUse[0].hooks[0].command;
    // Grok's own file carries the per-tool observation hook (NOT observation-batch).
    expect(command).toContain('observation');
    expect(command).not.toContain('observation-batch');
    expect(command).not.toContain('$'); // zero-$ launcher contract for Grok
  });

  it('uninstall removes the file and is idempotent', async () => {
    const { installGrokIntegration, uninstallGrokIntegration, getGrokHooksPath } = await import(
      '../../src/services/integrations/GrokInstaller.js'
    );
    installGrokIntegration();
    const hooksPath = getGrokHooksPath();
    expect(existsSync(hooksPath)).toBe(true);

    expect(uninstallGrokIntegration()).toBe(0);
    expect(existsSync(hooksPath)).toBe(false);

    // Second uninstall is a no-op success.
    expect(uninstallGrokIntegration()).toBe(0);
  });
});
