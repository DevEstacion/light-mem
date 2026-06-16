
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('SettingsDefaultsManager', () => {
  let tempDir: string;
  let settingsPath: string;
  let prevDataDirEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');

    // The preload tripwire (tests/preload.ts) pins LIGHT_MEM_DATA_DIR for
    // the whole run, and loadFromFile applies env overrides on top of file
    // values — which would make every loadFromFile result diverge from
    // getAllDefaults()'s hardcoded ~/.light-mem default. These tests are
    // about file > defaults behavior on an EXPLICIT settingsPath (no real
    // data-dir I/O happens here), so drop the env override for their
    // duration and restore it after.
    prevDataDirEnv = process.env.LIGHT_MEM_DATA_DIR;
    delete process.env.LIGHT_MEM_DATA_DIR;
  });

  afterEach(() => {
    if (prevDataDirEnv === undefined) delete process.env.LIGHT_MEM_DATA_DIR;
    else process.env.LIGHT_MEM_DATA_DIR = prevDataDirEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadFromFile', () => {
    describe('file does not exist', () => {
      it('should create file with defaults when file does not exist', () => {
        expect(existsSync(settingsPath)).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(existsSync(settingsPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should write valid JSON to the created file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(() => JSON.parse(content)).not.toThrow();
      });

      it('should write pretty-printed JSON (2-space indent)', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(content).toContain('\n');
        expect(content).toContain('  "LIGHT_MEM_MODEL"');
      });

      it('should write all default keys to the file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        const defaults = SettingsDefaultsManager.getAllDefaults();

        for (const key of Object.keys(defaults)) {
          expect(parsed).toHaveProperty(key);
        }
      });
    });

    describe('directory does not exist', () => {
      it('should create directory and file when parent directory does not exist', () => {
        const nestedPath = join(tempDir, 'nested', 'deep', 'settings.json');
        expect(existsSync(join(tempDir, 'nested'))).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(nestedPath);

        expect(existsSync(join(tempDir, 'nested', 'deep'))).toBe(true);
        expect(existsSync(nestedPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should create deeply nested directories recursively', () => {
        const deepPath = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'settings.json');

        SettingsDefaultsManager.loadFromFile(deepPath);

        expect(existsSync(join(tempDir, 'a', 'b', 'c', 'd', 'e'))).toBe(true);
        expect(existsSync(deepPath)).toBe(true);
      });
    });

    describe('file exists with valid content', () => {
      it('should return parsed content when file has valid JSON', () => {
        const customSettings = {
          LIGHT_MEM_MODEL: 'custom-model',
          LIGHT_MEM_WORKER_PORT: '12345',
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.LIGHT_MEM_MODEL).toBe('custom-model');
        expect(result.LIGHT_MEM_WORKER_PORT).toBe('12345');
      });

      it('should merge file settings with defaults for missing keys', () => {
        const partialSettings = {
          LIGHT_MEM_MODEL: 'partial-model',
        };
        writeFileSync(settingsPath, JSON.stringify(partialSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);
        const defaults = SettingsDefaultsManager.getAllDefaults();

        expect(result.LIGHT_MEM_MODEL).toBe('partial-model');
        expect(result.LIGHT_MEM_WORKER_PORT).toBe(defaults.LIGHT_MEM_WORKER_PORT);
        expect(result.LIGHT_MEM_WORKER_HOST).toBe(defaults.LIGHT_MEM_WORKER_HOST);
        expect(result.LIGHT_MEM_LOG_LEVEL).toBe(defaults.LIGHT_MEM_LOG_LEVEL);
      });

      it('should not modify existing file when loading', () => {
        const customSettings = {
          LIGHT_MEM_MODEL: 'do-not-change',
          CUSTOM_KEY: 'should-persist', // Extra key not in defaults
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2));
        const originalContent = readFileSync(settingsPath, 'utf-8');

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const afterContent = readFileSync(settingsPath, 'utf-8');
        expect(afterContent).toBe(originalContent);
      });

      it('should handle all settings keys correctly', () => {
        const fullSettings = SettingsDefaultsManager.getAllDefaults();
        fullSettings.LIGHT_MEM_MODEL = 'all-keys-model';
        writeFileSync(settingsPath, JSON.stringify(fullSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.LIGHT_MEM_MODEL).toBe('all-keys-model');
      });
    });

    describe('file exists but is empty or corrupt', () => {
      it('should return defaults when file is empty', () => {
        writeFileSync(settingsPath, '');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains invalid JSON', () => {
        writeFileSync(settingsPath, 'not valid json {{{{');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains only whitespace', () => {
        writeFileSync(settingsPath, '   \n\t  ');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains null', () => {
        writeFileSync(settingsPath, 'null');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains array instead of object', () => {
        writeFileSync(settingsPath, '["array", "not", "object"]');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains primitive value', () => {
        writeFileSync(settingsPath, '"just a string"');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });
    });

    describe('nested schema migration', () => {
      it('should migrate old nested { env: {...} } schema to flat schema', () => {
        const nestedSettings = {
          env: {
            LIGHT_MEM_MODEL: 'nested-model',
            LIGHT_MEM_WORKER_PORT: '54321',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.LIGHT_MEM_MODEL).toBe('nested-model');
        expect(result.LIGHT_MEM_WORKER_PORT).toBe('54321');
      });

      it('should auto-migrate file from nested to flat schema', () => {
        const nestedSettings = {
          env: {
            LIGHT_MEM_MODEL: 'migrated-model',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.env).toBeUndefined();
        expect(parsed.LIGHT_MEM_MODEL).toBe('migrated-model');
      });
    });

    describe('edge cases', () => {
      it('should handle empty object in file', () => {
        writeFileSync(settingsPath, '{}');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should ignore unknown keys in file', () => {
        const settingsWithUnknown = {
          LIGHT_MEM_MODEL: 'known-model',
          UNKNOWN_KEY: 'should-be-ignored',
          ANOTHER_UNKNOWN: 12345,
        };
        writeFileSync(settingsPath, JSON.stringify(settingsWithUnknown));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.LIGHT_MEM_MODEL).toBe('known-model');
        expect((result as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
      });

      it('should handle file with BOM', () => {
        const bom = '\uFEFF';
        const settings = { LIGHT_MEM_MODEL: 'bom-model' };
        writeFileSync(settingsPath, bom + JSON.stringify(settings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toBeDefined();
      });
    });
  });

  describe('stdout discipline', () => {
    // CLI commands like `start` promise machine-readable JSON on stdout to
    // the hook framework; settings bootstrap runs inside them, so its
    // informational notices must go to stderr. PR #2894 CI caught the
    // creation notice corrupting the start command's JSON on first boot in
    // a fresh data dir.
    it('should not write to stdout when creating the settings file', () => {
      const stdoutCalls: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { stdoutCalls.push(args); };
      try {
        expect(existsSync(settingsPath)).toBe(false);
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(existsSync(settingsPath)).toBe(true);
        expect(stdoutCalls).toEqual([]);
      } finally {
        console.log = originalLog;
      }
    });

    it('should not write to stdout when migrating a nested-schema file', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { LIGHT_MEM_MODEL: 'nested-model' } }));
      const stdoutCalls: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { stdoutCalls.push(args); };
      try {
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(stdoutCalls).toEqual([]);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('getAllDefaults', () => {
    it('should return a copy of defaults', () => {
      const defaults1 = SettingsDefaultsManager.getAllDefaults();
      const defaults2 = SettingsDefaultsManager.getAllDefaults();

      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2); 
    });

    it('should include all expected keys', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      expect(defaults.LIGHT_MEM_MODEL).toBeDefined();
      expect(defaults.LIGHT_MEM_WORKER_PORT).toBeDefined();
      expect(defaults.LIGHT_MEM_WORKER_HOST).toBeDefined();

      expect(defaults.LIGHT_MEM_DATA_DIR).toBeDefined();
      expect(defaults.LIGHT_MEM_LOG_LEVEL).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return default value for key', () => {
      expect(SettingsDefaultsManager.get('LIGHT_MEM_MODEL')).toBe('haiku');
      const expectedPort = String(37700 + ((process.getuid?.() ?? 77) % 100));
      expect(SettingsDefaultsManager.get('LIGHT_MEM_WORKER_PORT')).toBe(expectedPort);
    });
  });

  describe('getInt', () => {
    it('should return integer value for numeric string', () => {
      const expectedPort = 37700 + ((process.getuid?.() ?? 77) % 100);
      expect(SettingsDefaultsManager.getInt('LIGHT_MEM_WORKER_PORT')).toBe(expectedPort);
      expect(SettingsDefaultsManager.getInt('LIGHT_MEM_CONTEXT_OBSERVATIONS')).toBe(50);
    });
  });

  describe('getBool', () => {
    it('should return true for "true" string', () => {
      expect(SettingsDefaultsManager.getBool('LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT')).toBe(true);
    });

    it('should return false for non-"true" string', () => {
      expect(SettingsDefaultsManager.getBool('LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE')).toBe(false);
    });
  });

  describe('environment variable overrides', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      originalEnv.LIGHT_MEM_WORKER_PORT = process.env.LIGHT_MEM_WORKER_PORT;
      originalEnv.LIGHT_MEM_MODEL = process.env.LIGHT_MEM_MODEL;
      originalEnv.LIGHT_MEM_LOG_LEVEL = process.env.LIGHT_MEM_LOG_LEVEL;
    });

    afterEach(() => {
      if (originalEnv.LIGHT_MEM_WORKER_PORT === undefined) {
        delete process.env.LIGHT_MEM_WORKER_PORT;
      } else {
        process.env.LIGHT_MEM_WORKER_PORT = originalEnv.LIGHT_MEM_WORKER_PORT;
      }
      if (originalEnv.LIGHT_MEM_MODEL === undefined) {
        delete process.env.LIGHT_MEM_MODEL;
      } else {
        process.env.LIGHT_MEM_MODEL = originalEnv.LIGHT_MEM_MODEL;
      }
      if (originalEnv.LIGHT_MEM_LOG_LEVEL === undefined) {
        delete process.env.LIGHT_MEM_LOG_LEVEL;
      } else {
        process.env.LIGHT_MEM_LOG_LEVEL = originalEnv.LIGHT_MEM_LOG_LEVEL;
      }
    });

    it('should prioritize env var over file setting', () => {
      const fileSettings = {
        LIGHT_MEM_WORKER_PORT: '12345',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      process.env.LIGHT_MEM_WORKER_PORT = '54321';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.LIGHT_MEM_WORKER_PORT).toBe('54321');
    });

    it('should prioritize env var over default', () => {
      process.env.LIGHT_MEM_WORKER_PORT = '99999';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.LIGHT_MEM_WORKER_PORT).toBe('99999');
    });

    it('should use file setting when env var is not set', () => {
      const fileSettings = {
        LIGHT_MEM_WORKER_PORT: '11111',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      delete process.env.LIGHT_MEM_WORKER_PORT;

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.LIGHT_MEM_WORKER_PORT).toBe('11111');
    });

    it('should apply env var override even on file parse error', () => {
      writeFileSync(settingsPath, 'invalid json {{{');
      process.env.LIGHT_MEM_WORKER_PORT = '88888';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.LIGHT_MEM_WORKER_PORT).toBe('88888');
    });

    it('should apply multiple env var overrides', () => {
      const fileSettings = {
        LIGHT_MEM_WORKER_PORT: '12345',
        LIGHT_MEM_MODEL: 'file-model',
        LIGHT_MEM_LOG_LEVEL: 'DEBUG',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      process.env.LIGHT_MEM_WORKER_PORT = '54321';
      process.env.LIGHT_MEM_MODEL = 'env-model';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.LIGHT_MEM_WORKER_PORT).toBe('54321');
      expect(result.LIGHT_MEM_MODEL).toBe('env-model');
      expect(result.LIGHT_MEM_LOG_LEVEL).toBe('DEBUG'); 
    });

    it('should document priority: env > file > defaults', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const fileSettings = {
        LIGHT_MEM_WORKER_PORT: '22222', // Different from default 37777
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      process.env.LIGHT_MEM_WORKER_PORT = '33333';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      const expectedDefault = String(37700 + ((process.getuid?.() ?? 77) % 100));
      expect(defaults.LIGHT_MEM_WORKER_PORT).toBe(expectedDefault); 
      expect(result.LIGHT_MEM_WORKER_PORT).toBe('33333'); 
    });
  });
});
