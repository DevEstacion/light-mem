
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { HOOK_TIMEOUTS, getTimeout } from './hook-constants.js';

export interface SettingsDefaults {
  LIGHT_MEM_MODEL: string;
  LIGHT_MEM_CONTEXT_OBSERVATIONS: string;
  LIGHT_MEM_WORKER_PORT: string;
  LIGHT_MEM_WORKER_HOST: string;
  LIGHT_MEM_API_TIMEOUT_MS: string;
  LIGHT_MEM_SKIP_TOOLS: string;
  LIGHT_MEM_CLAUDE_AUTH_METHOD: string;
  LIGHT_MEM_DATA_DIR: string;
  LIGHT_MEM_LOG_LEVEL: string;
  CLAUDE_CODE_PATH: string;
  LIGHT_MEM_MODE: string;
  LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  LIGHT_MEM_CONTEXT_FULL_COUNT: string;
  LIGHT_MEM_CONTEXT_FULL_FIELD: string;
  LIGHT_MEM_CONTEXT_SESSION_COUNT: string;
  LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  LIGHT_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  LIGHT_MEM_WELCOME_HINT_ENABLED: string;
  LIGHT_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  LIGHT_MEM_FOLDER_USE_LOCAL_MD: string;  
  LIGHT_MEM_TRANSCRIPTS_ENABLED: string;  
  LIGHT_MEM_TRANSCRIPTS_CONFIG_PATH: string;  
  LIGHT_MEM_CODEX_TRANSCRIPT_INGESTION: string;
  LIGHT_MEM_MAX_CONCURRENT_AGENTS: string;  
  LIGHT_MEM_HOOK_FAIL_LOUD_THRESHOLD: string;  
  LIGHT_MEM_EXCLUDED_PROJECTS: string;  
  LIGHT_MEM_FOLDER_MD_EXCLUDE: string;
  LIGHT_MEM_FOLDER_MD_SKELETON_DENYLIST: string;
  LIGHT_MEM_SEMANTIC_INJECT: string;        
  LIGHT_MEM_SEMANTIC_INJECT_LIMIT: string;  
  LIGHT_MEM_TIER_ROUTING_ENABLED: string;
  LIGHT_MEM_TIER_SIMPLE_MODEL: string;
  LIGHT_MEM_TIER_SUMMARY_MODEL: string;
  LIGHT_MEM_TIER_FAST_MODEL: string;        // #2289 — resolved by $TIER:fast in LIGHT_MEM_MODEL
  LIGHT_MEM_TIER_SMART_MODEL: string;       // #2289 — resolved by $TIER:smart in LIGHT_MEM_MODEL
  LIGHT_MEM_CHROMA_ENABLED: string;
  LIGHT_MEM_QUEUE_ENGINE: string;
  LIGHT_MEM_AUTH_MODE: string;
  LIGHT_MEM_RUNTIME: string;
}

export class SettingsDefaultsManager {
  private static readonly DEFAULTS: SettingsDefaults = {
    LIGHT_MEM_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    LIGHT_MEM_CONTEXT_OBSERVATIONS: '50',
    LIGHT_MEM_WORKER_PORT: String(37700 + ((process.getuid?.() ?? 77) % 100)),
    LIGHT_MEM_WORKER_HOST: '127.0.0.1',
    LIGHT_MEM_API_TIMEOUT_MS: String(getTimeout(HOOK_TIMEOUTS.API_REQUEST)),
    LIGHT_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    LIGHT_MEM_CLAUDE_AUTH_METHOD: 'subscription',  // Default to logged-in Claude SDK auth (not API key)
    LIGHT_MEM_DATA_DIR: join(homedir(), '.light-mem'),
    LIGHT_MEM_LOG_LEVEL: 'INFO',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    LIGHT_MEM_MODE: 'code', // Default mode profile
    LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    LIGHT_MEM_CONTEXT_FULL_COUNT: '0',
    LIGHT_MEM_CONTEXT_FULL_FIELD: 'narrative',
    LIGHT_MEM_CONTEXT_SESSION_COUNT: '10',
    LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    LIGHT_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    LIGHT_MEM_WELCOME_HINT_ENABLED: 'true',
    LIGHT_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    LIGHT_MEM_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    LIGHT_MEM_TRANSCRIPTS_ENABLED: 'true',
    LIGHT_MEM_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.light-mem', 'transcript-watch.json'),
    LIGHT_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
    LIGHT_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Claude SDK agent subprocesses
    LIGHT_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // Plan 05 Phase 8 — escalate to exit code 2 after N consecutive worker-unreachable hook invocations
    LIGHT_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    LIGHT_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    LIGHT_MEM_FOLDER_MD_SKELETON_DENYLIST: '[]',  // #2400 — JSON array of glob patterns; when a folder matches AND its generated CLAUDE.md would be empty/skeleton, skip injection (avoids polluting non-content dirs with empty skeletons). Default [] preserves existing behavior.
    LIGHT_MEM_SEMANTIC_INJECT: 'false',             // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    LIGHT_MEM_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    LIGHT_MEM_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    LIGHT_MEM_TIER_SIMPLE_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    LIGHT_MEM_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    LIGHT_MEM_TIER_FAST_MODEL: 'haiku',              // #2289 — $TIER:fast resolves here (portable alias)
    LIGHT_MEM_TIER_SMART_MODEL: 'sonnet',            // #2289 — $TIER:smart resolves here (portable alias)
    LIGHT_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable in-process vector search
    LIGHT_MEM_QUEUE_ENGINE: 'sqlite',
    LIGHT_MEM_AUTH_MODE: 'api-key',
    LIGHT_MEM_RUNTIME: 'worker',
  };

  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  static get(key: keyof SettingsDefaults): string {
    return process.env[key] ?? this.DEFAULTS[key];
  }

  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  static getBool(key: keyof SettingsDefaults): boolean {
    const value: unknown = this.get(key);
    return value === 'true' || value === true;
  }

  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  static loadFromFile(settingsPath: string, applyEnvOverrides = true): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // stderr, never stdout: this fires on the first boot in a fresh data
          // dir, and CLI commands like `start` promise machine-readable JSON
          // on stdout to the hook framework.
          console.warn('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error instanceof Error ? error.message : String(error));
        }
        return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      // Strip UTF-8 BOM if present — Windows tools (editors, formatters, CLI
      // hooks) may prepend U+FEFF which Bun's JSON.parse rejects silently,
      // causing a full fallback to defaults and breaking server-beta routing.
      const settings = JSON.parse(settingsData.replace(/^\uFEFF/, ''));

      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        flatSettings = settings.env;

        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with in-memory migration even if write fails
        }
      }

      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return applyEnvOverrides ? this.applyEnvOverrides(result) : result;
    } catch (error: unknown) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error instanceof Error ? error.message : String(error));
      const defaults = this.getAllDefaults();
      return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
    }
  }
}
