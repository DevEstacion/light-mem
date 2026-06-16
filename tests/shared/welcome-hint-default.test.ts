
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('LIGHT_MEM_WELCOME_HINT_ENABLED default', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `welcome-hint-default-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    originalEnvValue = process.env.LIGHT_MEM_WELCOME_HINT_ENABLED;
    delete process.env.LIGHT_MEM_WELCOME_HINT_ENABLED;
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.LIGHT_MEM_WELCOME_HINT_ENABLED;
    } else {
      process.env.LIGHT_MEM_WELCOME_HINT_ENABLED = originalEnvValue;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('is set to "true" in getAllDefaults()', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.LIGHT_MEM_WELCOME_HINT_ENABLED).toBe('true');
  });

  it('resolves to "true" when settings file is missing (auto-created with defaults)', () => {
    expect(existsSync(settingsPath)).toBe(false);

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.LIGHT_MEM_WELCOME_HINT_ENABLED).toBe('true');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('resolves to "true" when settings file is empty JSON object', () => {
    writeFileSync(settingsPath, '{}', 'utf-8');

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.LIGHT_MEM_WELCOME_HINT_ENABLED).toBe('true');
  });

  it('preserves an explicit "false" value through loadFromFile', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ LIGHT_MEM_WELCOME_HINT_ENABLED: 'false' }, null, 2),
      'utf-8',
    );

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.LIGHT_MEM_WELCOME_HINT_ENABLED).toBe('false');
  });
});
