import * as p from '@clack/prompts';
import pc from 'picocolors';
import { spawnHidden } from '../../shared/spawn.js';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadLightMemEnv, saveLightMemEnv } from '../../shared/EnvManager.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../../services/worker-spawner.js';
import {
  ensureNode,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';
import { ErrorSeverity } from '../install/error-taxonomy.js';
import {
  createInstallSummary,
  flushSummary,
  installerError,
  InstallAbortError,
  type InstallSummary,
} from '../install/error-reporter.js';
import { extractEresolveBlock, isEresolve, runNpmStrict } from '../install/npm-install-helper.js';
import { resolveBedrockModel } from '../install/bedrock-models.js';

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

const isInteractive = process.stdin.isTTY === true;

interface TaskDescriptor {
  title: string;
  task: (message: (msg: string) => void) => Promise<string>;
}

async function runTasks(tasks: TaskDescriptor[]): Promise<void> {
  if (isInteractive) {
    await p.tasks(tasks);
  } else {
    for (const t of tasks) {
      const result = await t.task((msg: string) => console.log(`  ${msg}`));
      console.log(`  ${result}`);
    }
  }
}

/**
 * Tick a task's spinner message with elapsed seconds. The multi-minute
 * dependency installs used to sit on one static message (and previously a
 * blocked event loop), which read as a stalled install. Returns a stop
 * function for a finally block. Non-interactive runs get the label once —
 * a per-second console.log line would spam CI logs.
 */
function startHeartbeat(message: (msg: string) => void, label: string): () => void {
  message(label);
  if (!isInteractive) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    message(`${label} ${pc.dim(`(${elapsed}s — still working)`)}`);
  }, 1000);
  return () => clearInterval(timer);
}

async function bufferConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  if (!isInteractive) {
    const result = await fn();
    return { result, output: '' };
  }
  let buffer = '';
  const append = (...args: unknown[]) => {
    buffer += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = append;
  console.error = append;
  console.warn = append;
  try {
    const result = await fn();
    return { result, output: buffer };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}

const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};
import {
  claudeSettingsPath,
  ensureDirectoryExists,
  installedPluginsPath,
  IS_WINDOWS,
  knownMarketplacesPath,
  marketplaceDirectory,
  npmPackagePluginDirectory,
  npmPackageRootDirectory,
  pluginCacheDirectory,
  pluginsDirectory,
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import { detectInstalledIDEs } from './ide-detection.js';

function registerMarketplace(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});

  knownMarketplaces['light-mem'] = {
    source: {
      source: 'directory',
      path: marketplaceDirectory(),
    },
    installLocation: marketplaceDirectory(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };

  ensureDirectoryExists(pluginsDirectory());
  writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
}

function registerPlugin(version: string): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});

  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};

  const cachePath = pluginCacheDirectory(version);
  const now = new Date().toISOString();

  installedPlugins.plugins['light-mem@light-mem'] = [
    {
      scope: 'user',
      installPath: cachePath,
      version,
      installedAt: now,
      lastUpdated: now,
    },
  ];

  writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
}

function enablePluginInClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['light-mem@light-mem'] = true;

  writeJsonFileAtomic(claudeSettingsPath(), settings);
}

/**
 * Disable Claude Code's built-in auto-memory by setting CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
 * in ~/.claude/settings.json `env` block. light-mem provides its own persistent memory
 * via plugin hooks; the built-in MEMORY.md system creates shadow state outside the user's
 * control and competes with light-mem for context window tokens.
 *
 * Per anthropics/claude-code#23544, the env var is the only supported toggle.
 *
 * Idempotent: only writes when not already set, preserves existing env vars and other
 * settings keys, and merges atomically. Returns true when a write happened (for the
 * caller to surface in the install summary).
 */
export function disableClaudeAutoMemory(): boolean {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};

  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') {
    return false;
  }

  settings.env = { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  writeJsonFileAtomic(claudeSettingsPath(), settings);
  return true;
}

type ClaudeAutoMemoryChoice = 'disable' | 'leave-enabled' | 'not-applicable';

async function resolveClaudeAutoMemoryChoice(
  selectedIDEs: string[],
  options: InstallOptions,
): Promise<ClaudeAutoMemoryChoice> {
  if (!selectedIDEs.includes('claude-code')) {
    return 'not-applicable';
  }

  if (options.disableAutoMemory) {
    return 'disable';
  }

  if (!isInteractive) {
    return 'leave-enabled';
  }

  const choice = await p.select<'leave-enabled' | 'disable'>({
    message: 'Disable Claude Code auto-memory?',
    options: [
      {
        value: 'leave-enabled',
        label: 'Leave enabled',
        hint: 'Recommended; keeps Claude Code native memory visible on startup.',
      },
      {
        value: 'disable',
        label: 'Disable auto-memory',
        hint: 'Only if you explicitly want light-mem to replace native startup memory.',
      },
    ],
    initialValue: 'leave-enabled',
  });

  if (p.isCancel(choice)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice;
}

function makeIDETask(ideId: string, summary: InstallSummary): TaskDescriptor | null {
  const recordFailure = (label: string, output: string) => {
    // Route every per-IDE failure through the central decision point. A single
    // IDE failure is FAIL_LOUD_PER_IDE (partial install); the summary headline
    // and exit code reflect it. The stderr is preserved verbatim in `details`.
    installerError(ErrorSeverity.FAIL_LOUD_PER_IDE, {
      component: label,
      ide: ideId,
      phase: 'ide-install',
      cause: new Error(label),
      details: output && output.trim().length > 0 ? output.trim().slice(0, 4000) : undefined,
    }, summary);
  };

  switch (ideId) {
    case 'claude-code': {
      return {
        title: 'Claude Code: registering plugin',
        task: async () => `Claude Code: plugin registered ${pc.green('OK')}`,
      };
    }

    case 'opencode': {
      const allIDEs = detectInstalledIDEs();
      const ideInfo = allIDEs.find((i) => i.id === ideId);
      const ideLabel = ideInfo?.label ?? 'OpenCode';
      return {
        title: `${ideLabel}: installing plugin integration`,
        task: async (message) => {
          message('Loading OpenCode installer…');
          const { installOpenCodeIntegration } = await import('../../services/integrations/OpenCodeInstaller.js');
          message('Installing OpenCode plugin…');
          const { result, output } = await bufferConsole(() => installOpenCodeIntegration());
          if (result !== 0) {
            recordFailure(`${ideLabel}: plugin integration failed`, output);
            return `${ideLabel}: plugin integration failed ${pc.red('FAIL')}`;
          }
          return `${ideLabel}: plugin integration installed ${pc.green('OK')}`;
        },
      };
    }

    case 'copilot-cli':
    case 'antigravity':
    case 'goose':
    case 'roo-code':
    case 'warp': {
      const allIDEs = detectInstalledIDEs();
      const ideInfo = allIDEs.find((i) => i.id === ideId);
      const ideLabel = ideInfo?.label ?? ideId;
      return {
        title: `${ideLabel}: installing MCP integration`,
        task: async (message) => {
          message('Loading MCP installer…');
          const { MCP_IDE_INSTALLERS } = await import('../../services/integrations/McpIntegrations.js');
          const mcpInstaller = MCP_IDE_INSTALLERS[ideId];
          if (!mcpInstaller) {
            return `${ideLabel}: MCP installer not found ${pc.yellow('!')}`;
          }
          message(`Configuring ${ideLabel} MCP…`);
          const { result, output } = await bufferConsole(() => mcpInstaller());
          if (result !== 0) {
            recordFailure(`${ideLabel}: MCP integration failed`, output);
            return `${ideLabel}: MCP integration failed ${pc.red('FAIL')}`;
          }
          return `${ideLabel}: MCP integration installed ${pc.green('OK')}`;
        },
      };
    }

    default: {
      const allIDEs = detectInstalledIDEs();
      const ide = allIDEs.find((i) => i.id === ideId);
      if (ide && !ide.supported) {
        return {
          title: `${ide.label}: skipping`,
          task: async () => `${ide.label}: support coming soon ${pc.yellow('!')}`,
        };
      }
      return null;
    }
  }
}

async function setupIDEs(selectedIDEs: string[], summary: InstallSummary): Promise<string[]> {
  const tasks: TaskDescriptor[] = [];
  for (const ideId of selectedIDEs) {
    const taskDescriptor = makeIDETask(ideId, summary);
    if (taskDescriptor) tasks.push(taskDescriptor);
  }

  if (tasks.length > 0) {
    await runTasks(tasks);
  }

  // FAIL_LOUD_PER_IDE failures were recorded on the summary; if EVERY selected
  // IDE failed, escalate to an ABORT (all-ides-failed) — a fully failed install
  // must not print "Installation Complete".
  if (selectedIDEs.length > 0 && summary.failedIDEs.length === selectedIDEs.length) {
    installerError(ErrorSeverity.ABORT, {
      component: 'all-ides',
      phase: 'ide-install',
      cause: new Error(`All ${selectedIDEs.length} selected IDE integrations failed.`),
    }, summary);
  }

  return summary.failedIDEs;
}

function detectShellConfigFile(): { path: string; shell: 'zsh' | 'bash' | 'fish' } {
  const home = homedir();
  const shellEnv = process.env.SHELL ?? '';

  if (shellEnv.includes('fish')) {
    return { path: join(home, '.config', 'fish', 'config.fish'), shell: 'fish' };
  }
  if (shellEnv.includes('zsh')) {
    return { path: join(home, '.zshrc'), shell: 'zsh' };
  }
  if (process.platform === 'darwin') {
    const bashProfile = join(home, '.bash_profile');
    if (existsSync(bashProfile)) return { path: bashProfile, shell: 'bash' };
  }
  return { path: join(home, '.bashrc'), shell: 'bash' };
}

function applyClaudeCodePathSetupIfNeeded(): void {
  const home = homedir();
  const claudeBinDir = join(home, '.local', 'bin');
  const claudeBinary = join(claudeBinDir, 'claude');

  if (!existsSync(claudeBinary)) return;

  const currentPath = process.env.PATH ?? '';
  const pathEntries = currentPath.split(':');
  if (pathEntries.includes(claudeBinDir)) return;

  const { path: configFile, shell } = detectShellConfigFile();
  const binPathLiteral = '$HOME/.local/bin';
  const exportLine = shell === 'fish'
    ? `set -gx PATH ${claudeBinDir} $PATH`
    : `export PATH="${binPathLiteral}:$PATH"`;

  let existing = '';
  if (existsSync(configFile)) {
    try {
      existing = readFileSync(configFile, 'utf-8');
    } catch (error: unknown) {
      log.warn(`Could not read ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      mkdirSync(dirname(configFile), { recursive: true });
    } catch {
      // Best-effort directory creation.
    }
  }

  if (existing.includes(claudeBinDir) || existing.includes(binPathLiteral)) {
    log.info(`Claude Code PATH already configured in ${configFile}`);
  } else {
    try {
      const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const block = `${trailing}\n# Added by light-mem installer for Claude Code\n${exportLine}\n`;
      writeFileSync(configFile, existing + block, 'utf-8');
      log.success(`Added Claude Code to PATH in ${configFile}`);
    } catch (error: unknown) {
      log.warn(`Could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
      log.info(`Run manually: echo '${exportLine}' >> ${configFile}`);
      return;
    }
  }

  process.env.PATH = `${claudeBinDir}:${currentPath}`;
}

async function installClaudeCode(): Promise<boolean> {
  const command = IS_WINDOWS
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Installing Claude Code (this can take a few minutes — downloading the native build)…');

  return new Promise<boolean>((resolve) => {
    let captured = '';
    const child = spawnHidden(command, [], {
      shell: IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash',
      stdio: spinner ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });

    child.stdout?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });

    child.on('error', (error: Error) => {
      spinner?.error('Claude Code install failed');
      if (captured) process.stderr.write(captured);
      log.error(`Claude Code install failed: ${error.message}`);
      log.info('You can install it manually later: https://claude.ai/install.sh');
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        spinner?.error('Claude Code install failed');
        if (captured) process.stderr.write(captured);
        log.error(`Claude Code install failed (exit ${code ?? 'unknown'})`);
        log.info('You can install it manually later: https://claude.ai/install.sh');
        resolve(false);
        return;
      }
      spinner?.stop('Claude Code installed');
      if (!IS_WINDOWS) {
        try {
          applyClaudeCodePathSetupIfNeeded();
        } catch (error: unknown) {
          log.warn(`Could not auto-apply PATH setup: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      resolve(true);
    });
  });
}

async function promptForIDESelection(): Promise<string[]> {
  let detectedIDEs = detectInstalledIDEs();
  const claudeCodeInfo = detectedIDEs.find((ide) => ide.id === 'claude-code');

  if (claudeCodeInfo && !claudeCodeInfo.detected) {
    log.warn('Claude Code is not installed. light-mem works best in Claude Code, but also works with the IDEs below.');
    const choice = await p.select<'install' | 'skip' | 'cancel'>({
      message: 'Install Claude Code now?',
      options: [
        { value: 'install', label: 'Yes — install Claude Code (recommended)' },
        { value: 'skip', label: 'No — pick another IDE below' },
        { value: 'cancel', label: 'Cancel installation' },
      ],
      initialValue: 'install',
    });
    if (p.isCancel(choice) || choice === 'cancel') {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (choice === 'install') {
      if (await installClaudeCode()) {
        detectedIDEs = detectInstalledIDEs();
      }
    }
  }

  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    log.warn('No supported IDEs detected — pick the one(s) you plan to use.');
  }

  const options = detectedIDEs.map((ide) => {
    const detectedTag = ide.detected ? ' [detected]' : '';
    const hint = ide.supported ? `${ide.hint}${detectedTag}` : `coming soon${detectedTag}`;
    return {
      value: ide.id,
      label: ide.label,
      hint,
    };
  });

  const result = await p.multiselect({
    message: 'Which IDEs do you use?',
    options,
    initialValues: [],
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return result as string[];
}

function copyPluginToMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageRoot = npmPackageRootDirectory();

  ensureDirectoryExists(marketplaceDir);

  const allowedTopLevelEntries = [
    '.agents',
    'plugin',
    'package.json',
    'package-lock.json',
    'dist',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
  ];

  for (const entry of allowedTopLevelEntries) {
    const sourcePath = join(packageRoot, entry);
    const destPath = join(marketplaceDir, entry);
    if (!existsSync(sourcePath)) continue;

    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    cpSync(sourcePath, destPath, {
      recursive: true,
      force: true,
    });
  }
}

function copyPluginToCache(version: string): void {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  rmSync(cachePath, { recursive: true, force: true });
  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
}

/**
 * Install marketplace dependencies, strict-first.
 *
 * Phase 4 of plans/04-installer-transparency.md: the old code ALWAYS passed
 * `--legacy-peer-deps`, papering over any real peer conflict unconditionally.
 * Now we run strict first and only fall back to `--legacy-peer-deps` on a
 * confirmed ERESOLVE token, announced loudly. `--ignore-scripts` is the default
 * (v12.6.2 lesson: a transitive postinstall can hang the install).
 */
async function runNpmInstallInMarketplace(summary: InstallSummary): Promise<void> {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');

  if (!existsSync(packageJsonPath)) return;

  const baseFlags = ['install', '--omit=dev', '--ignore-scripts'];
  const strictResult = await runNpmStrict(marketplaceDir, baseFlags);
  if (strictResult.code === 0) return;

  if (strictResult.timedOut) {
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error('npm install timed out'),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  if (!isEresolve(strictResult.stderr)) {
    // A strict failure with no ERESOLVE is a real bug — never retry, ABORT.
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error(`npm install failed (exit ${strictResult.code})`),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  // Confirmed ERESOLVE — log loudly, attempt one fallback with --legacy-peer-deps.
  log.warn('npm reported an ERESOLVE peer-dependency conflict in marketplace deps; retrying once with --legacy-peer-deps.');
  log.warn(extractEresolveBlock(strictResult.stderr));

  const legacyResult = await runNpmStrict(marketplaceDir, [...baseFlags, '--legacy-peer-deps']);
  if (legacyResult.code === 0) {
    summary.warnings.push({
      component: 'marketplace-npm-install',
      message: 'tree-sitter peer-dep ERESOLVE was resolved with the --legacy-peer-deps fallback. Benign for the marketplace install; re-evaluate when tree-sitter peer ranges change.',
      remediation: 'No action required.',
    });
    return;
  }

  installerError(ErrorSeverity.ABORT, {
    component: 'marketplace-npm-install',
    phase: 'marketplace-deps',
    cause: new Error(`npm install --legacy-peer-deps still failed (exit ${legacyResult.code}): ERESOLVE`),
    details: legacyResult.stderr.slice(0, 4000),
  }, summary);
}

function mergeSettings(updates: Record<string, string>): boolean {
  const path = USER_SETTINGS_PATH;
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object') {
          current = { ...parsed.env };
        } else if (parsed && typeof parsed === 'object') {
          current = { ...parsed };
        }
      } catch (parseError: unknown) {
        console.warn('[install] Failed to parse existing settings.json, starting from empty:', parseError instanceof Error ? parseError.message : String(parseError));
        current = {};
      }
    } else {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      current[key] = value;
    }

    writeFileSync(path, JSON.stringify(current, null, 2), 'utf-8');
    return true;
  } catch (error: unknown) {
    log.error(`Failed to write settings to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

type ProviderId = 'claude';
type ClaudeAccessMode = 'subscription' | 'api-key';
type ClaudeApiMode = 'direct' | 'gateway';

function readRawStoredAuthMethod(): 'subscription' | 'api-key' | 'gateway' | 'bedrock' | undefined {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return undefined;
    const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
    const value = flat.LIGHT_MEM_CLAUDE_AUTH_METHOD;
    if (value === 'subscription' || value === 'api-key' || value === 'gateway' || value === 'bedrock') return value;
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveClaudeAuthMethod(): 'subscription' | 'api-key' | 'gateway' | 'bedrock' {
  const stored = readRawStoredAuthMethod();
  if (stored) return stored;
  const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK?.trim();
  if (useBedrock && useBedrock !== '0' && useBedrock.toLowerCase() !== 'false') return 'bedrock';
  const env = loadLightMemEnv();
  if (env.ANTHROPIC_BASE_URL?.trim()) return 'gateway';
  if (env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
  return 'subscription';
}

async function promptRuntime(options: InstallOptions): Promise<'worker'> {
  if (options.runtime !== undefined && options.runtime !== 'worker') {
    log.info(`--runtime ${options.runtime} is not supported; using worker.`);
  }
  mergeSettings({ LIGHT_MEM_RUNTIME: 'worker' });
  return 'worker';
}

async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  const persistClaudeProvider = (authMethod?: 'subscription' | 'api-key' | 'gateway' | 'bedrock') => {
    const resolvedAuthMethod = authMethod ?? resolveClaudeAuthMethod();
    const wrote = mergeSettings({
      LIGHT_MEM_PROVIDER: 'claude',
      LIGHT_MEM_CLAUDE_AUTH_METHOD: resolvedAuthMethod,
    });
    if (wrote) log.info('Saved Claude Agent SDK configuration to ~/.light-mem/settings.json');
  };

  const useSubscriptionAuth = () => {
    persistClaudeProvider('subscription');
    saveLightMemEnv({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    log.info('Configured light-mem to use your logged-in Claude SDK account.');
  };

  const configureDirectApiKey = async (): Promise<void> => {
    const existing = loadLightMemEnv().ANTHROPIC_API_KEY || '';
    if (existing.trim().length > 0) {
      const choice = await p.select<'keep' | 'replace'>({
        message: 'An Anthropic API key is already configured. Keep it or enter a new one?',
        options: [
          { value: 'keep', label: 'Keep existing key' },
          { value: 'replace', label: 'Enter a new key (rotate)' },
        ],
        initialValue: 'keep',
      });
      if (p.isCancel(choice)) {
        log.warn('API key prompt cancelled — leaving existing configuration untouched.');
        return;
      }
      if (choice === 'keep') {
        saveLightMemEnv({
          ANTHROPIC_API_KEY: existing.trim(),
          ANTHROPIC_BASE_URL: '',
          ANTHROPIC_AUTH_TOKEN: '',
        });
        persistClaudeProvider('api-key');
        return;
      }
    }

    const apiKeyResult = await p.password({
      message: 'Paste your Anthropic API key:',
      mask: '*',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
    });

    if (p.isCancel(apiKeyResult)) {
      log.warn('API key prompt cancelled — leaving existing configuration untouched.');
      return;
    }

    saveLightMemEnv({
      ANTHROPIC_API_KEY: String(apiKeyResult).trim(),
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    persistClaudeProvider('api-key');
    log.info('Saved Anthropic API key for the Claude Agent SDK path.');
  };

  const configureGateway = async (): Promise<void> => {
    const existing = loadLightMemEnv();
    const baseUrlResult = await p.text({
      message: 'Gateway URL:',
      placeholder: existing.ANTHROPIC_BASE_URL || 'http://localhost:4000',
      defaultValue: existing.ANTHROPIC_BASE_URL || '',
      validate: (v?: string) => {
        const value = v?.trim() ?? '';
        if (!value) return 'Gateway URL required';
        try {
          new URL(value);
          return undefined;
        } catch {
          return 'Enter a valid URL, for example http://localhost:4000';
        }
      },
    });

    if (p.isCancel(baseUrlResult)) {
      log.warn('Gateway setup cancelled — leaving existing configuration untouched.');
      return;
    }

    const tokenResult = await p.password({
      message: 'Gateway key/token (leave blank to keep current token, or type a new one):',
      mask: '*',
    });

    const tokenCancelled = p.isCancel(tokenResult);
    const tokenInput = tokenCancelled ? '' : String(tokenResult).trim();
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: String(baseUrlResult).trim(),
    };
    if (!tokenCancelled && tokenInput.length > 0) {
      env.ANTHROPIC_AUTH_TOKEN = tokenInput;
    }
    saveLightMemEnv(env);
    persistClaudeProvider('gateway');
    if (tokenCancelled || tokenInput.length === 0) {
      log.info('Gateway URL saved; existing gateway token preserved.');
    } else {
      log.info('Configured Claude Agent SDK gateway in ~/.light-mem/.env.');
    }
  };

  if (!isInteractive) {
    persistClaudeProvider();
    return 'claude';
  }

  const runClaudeAuthFlow = async (): Promise<void> => {
    const resolvedAuthMethod = resolveClaudeAuthMethod();
    const initialAccessMode: ClaudeAccessMode =
      resolvedAuthMethod === 'subscription' ? 'subscription' : 'api-key';

    const result = await p.select<ClaudeAccessMode>({
      message: 'Do you use a subscription plan or an API key/gateway for the memory agent?',
      options: [
        { value: 'subscription', label: 'Subscription plan (recommended — uses your logged-in Claude SDK account)' },
        { value: 'api-key', label: 'API key or gateway (Anthropic, LiteLLM, or compatible proxy)' },
      ],
      initialValue: initialAccessMode,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (result === 'subscription') {
      useSubscriptionAuth();
      return;
    }

    const apiModeResult = await p.select<ClaudeApiMode>({
      message: 'How should light-mem connect?',
      options: [
        { value: 'direct', label: 'Anthropic API key' },
        { value: 'gateway', label: 'LiteLLM or custom gateway' },
      ],
      initialValue: resolvedAuthMethod === 'gateway' || loadLightMemEnv().ANTHROPIC_BASE_URL ? 'gateway' : 'direct',
    });

    if (p.isCancel(apiModeResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (apiModeResult === 'gateway') {
      await configureGateway();
    } else {
      await configureDirectApiKey();
    }
  };

  await runClaudeAuthFlow();
  return 'claude';
}

async function promptClaudeModel(options: InstallOptions): Promise<void> {
  const authMethod = resolveClaudeAuthMethod();

  // --- Bedrock branch ---
  if (authMethod === 'bedrock') {
    if (options.model) {
      const wrote = mergeSettings({ LIGHT_MEM_MODEL: options.model });
      if (wrote) {
        log.info(`Saved Bedrock model=${options.model} to ~/.light-mem/settings.json`);
      }
      return;
    }

    const haikuId = resolveBedrockModel('haiku');
    const sonnetId = resolveBedrockModel('sonnet');
    const opusId = resolveBedrockModel('opus');

    // Non-interactive (CI / --yes): persist a concrete, Bedrock-valid id rather
    // than leaving LIGHT_MEM_MODEL unset. The portable-alias default ('haiku')
    // also resolves on Bedrock, but the install contract is to select a working
    // id explicitly — default to Sonnet (the proven-good tier).
    if (!isInteractive) {
      const wrote = mergeSettings({ LIGHT_MEM_MODEL: sonnetId });
      if (wrote) {
        log.info(`Saved Bedrock model=${sonnetId} to ~/.light-mem/settings.json`);
      }
      return;
    }

    const result = await p.select<string>({
      message: 'Which Claude model should light-mem use to compress observations?\nThis runs whenever you and Claude touch a file — keep it cheap and fast.',
      options: [
        { value: haikuId, label: 'Haiku (fast, cheap, great for compression)' },
        { value: sonnetId, label: 'Sonnet (recommended — balanced quality and cost)' },
        { value: opusId, label: 'Opus (highest quality, most expensive)' },
      ],
      initialValue: sonnetId,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const selectedModel = result as string;
    const wrote = mergeSettings({ LIGHT_MEM_MODEL: selectedModel });
    if (wrote) {
      log.info(`Saved Bedrock model=${selectedModel} to ~/.light-mem/settings.json`);
    }
    return;
  }

  const allowed = new Set([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ]);
  const allowCustomModel = authMethod === 'gateway';

  if (options.model && !allowCustomModel) {
    if (!allowed.has(options.model)) {
      throw new Error(
        `Unknown Claude model: ${options.model}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    const wrote = mergeSettings({ LIGHT_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved Claude model=${options.model} to ~/.light-mem/settings.json`);
    }
    return;
  }
  if (options.model && allowCustomModel) {
    const wrote = mergeSettings({ LIGHT_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved gateway model=${options.model} to ~/.light-mem/settings.json`);
    }
    return;
  }

  if (!isInteractive) return;

  const initialModel = getSetting('LIGHT_MEM_MODEL');

  if (allowCustomModel) {
    const result = await p.text({
      message: 'Which model should the gateway use?',
      placeholder: 'claude-haiku-4-5-20251001',
      defaultValue: initialModel || 'claude-haiku-4-5-20251001',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'Model required' : undefined,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const selectedModel = String(result).trim();
    const wrote = mergeSettings({ LIGHT_MEM_MODEL: selectedModel });
    if (wrote) {
      log.info(`Saved gateway model=${selectedModel} to ~/.light-mem/settings.json`);
    }
    return;
  }

  const initialValue = allowed.has(initialModel) ? initialModel : 'claude-haiku-4-5-20251001';

  const result = await p.select<string>({
    message: 'Which Claude model should light-mem use to compress observations?\nThis runs whenever you and Claude touch a file — keep it cheap and fast.',
    options: [
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (recommended — fast, cheap, great for compression)' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced quality and cost)' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7 (highest quality, most expensive)' },
    ],
    initialValue,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }
  const selectedModel = result as string;

  const wrote = mergeSettings({ LIGHT_MEM_MODEL: selectedModel });
  if (wrote) {
    log.info(`Saved Claude model=${selectedModel} to ~/.light-mem/settings.json`);
  }
}

export interface InstallOptions {
  ide?: string;
  provider?: 'claude';
  model?: string;
  noAutoStart?: boolean;
  disableAutoMemory?: boolean;
  runtime?: 'worker';
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<void> {
  const summary = createInstallSummary();
  try {
    await runInstallCommandInner(options, summary);
  } catch (error: unknown) {
    if (error instanceof InstallAbortError) {
      // Flush whatever warnings accrued before the abort, then print the
      // remediation headline and exit non-zero. ABORT must never reach the
      // "Installation Complete" path.
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Installation Aborted: ${error.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(error.remediation);
        p.outro(pc.red('light-mem installation aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${error.remediation}`);
        console.error(`  ${error.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

async function runInstallCommandInner(options: InstallOptions, summary: InstallSummary): Promise<void> {
  const version = readPluginVersion();

  if (isInteractive) {
    await playBanner();
    p.intro(pc.bgCyan(pc.black(' light-mem install ')));
  } else {
    console.log('light-mem install');
  }
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  let existingVersion: string | undefined;
  if (alreadyInstalled) {
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      existingVersion = existingPluginJson.version ?? undefined;
    } catch (error: unknown) {
      console.warn('[install] Failed to read existing plugin version:', error instanceof Error ? error.message : String(error));
    }
  }

  const dot = pc.dim('·');
  const segments = [`${pc.bold('light-mem')} ${pc.cyan(`v${version}`)}`];
  if (existingVersion && existingVersion !== version) {
    segments.push(`installed ${pc.yellow(`v${existingVersion}`)}`);
  } else if (existingVersion) {
    segments.push(pc.dim('reinstall'));
  }
  log.info(segments.join(` ${dot} `));

  if (alreadyInstalled) {
    if (process.stdin.isTTY) {
      const shouldContinue = await p.confirm({
        message: 'Overwrite existing installation?',
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel('Installation cancelled.');
        process.exit(0);
      }
    }
  }

  let selectedIDEs: string[];
  if (options.ide) {
    selectedIDEs = [options.ide];
    const allIDEs = detectInstalledIDEs();
    const match = allIDEs.find((i) => i.id === options.ide);
    if (match && !match.supported) {
      log.error(`Support for ${match.label} coming soon.`);
      process.exit(1);
    }
    if (!match) {
      log.error(`Unknown IDE: ${options.ide}`);
      log.info(`Available IDEs: ${allIDEs.map((i) => i.id).join(', ')}`);
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    selectedIDEs = await promptForIDESelection();
  } else {
    selectedIDEs = ['claude-code'];
  }

  const selectedRuntime = await promptRuntime(options);
  const selectedProvider = await promptProvider(options);
  if (selectedProvider === 'claude') {
    await promptClaudeModel(options);
  }

  let workerStartResult: WorkerStartResult = 'dead';
  // Claude Code consumes the marketplace plugin system directly, so any selection
  // (claude-code or otherwise) needs the marketplace + plugin registration steps.
  // The only time we'd skip is a hypothetical no-IDE install, which the prompt above
  // doesn't allow today.
  const needsMarketplace = selectedIDEs.length > 0;

  {
    if (needsMarketplace) {
      const installPort = getSetting('LIGHT_MEM_WORKER_PORT');
      const shutdownSpinner = isInteractive ? p.spinner() : null;
      shutdownSpinner?.start('Stopping running worker (so we can overwrite cleanly)…');
      try {
        const result = await shutdownWorkerAndWait(installPort, 10000);
        if (shutdownSpinner) {
          shutdownSpinner.stop(
            result.workerWasRunning
              ? 'Stopped running worker before overwrite.'
              : 'No worker running — proceeding.',
          );
        } else if (result.workerWasRunning) {
          log.info('Stopped running worker before overwrite.');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (shutdownSpinner) {
          shutdownSpinner.error(`Pre-overwrite worker shutdown failed: ${message}`);
        } else {
          console.warn('[install] Pre-overwrite worker shutdown failed:', message);
        }
      }
    }

    const tasks: TaskDescriptor[] = [
      {
        title: 'Caching plugin version',
        task: async (message) => {
          message(`Caching v${version}...`);
          copyPluginToCache(version);
          return `Plugin cached (v${version}) ${pc.green('OK')}`;
        },
      },
      {
        title: 'Registering marketplace',
        task: async () => {
          registerMarketplace();
          return `Marketplace registered ${pc.green('OK')}`;
        },
      },
      {
        title: 'Registering plugin',
        task: async () => {
          registerPlugin(version);
          return `Plugin registered ${pc.green('OK')}`;
        },
      },
      {
        title: 'Enabling plugin in Claude settings',
        task: async () => {
          enablePluginInClaudeSettings();
          return `Plugin enabled ${pc.green('OK')}`;
        },
      },
      {
        title: 'Setting up runtime (first install can take ~30s)',
        task: async (message) => {
          message('Checking Node…');
          const { version: nodeVersion } = await ensureNode(summary);
          const cacheDir = pluginCacheDirectory(version);
          if (!isInstallCurrent(cacheDir, version)) {
            const stopHeartbeat = startHeartbeat(message, 'Installing plugin dependencies (npm install)…');
            try {
              await installPluginDependencies(cacheDir);
            } finally {
              stopHeartbeat();
            }
            writeInstallMarker(cacheDir, version, nodeVersion);
          }
          return `Runtime ready (Node ${nodeVersion}) ${pc.green('OK')}`;
        },
      },
    ];

    if (needsMarketplace) {
      tasks.unshift({
        title: 'Copying plugin files to marketplace',
        task: async (message) => {
          message('Copying to marketplace directory...');
          copyPluginToMarketplace();
          return `Plugin files copied ${pc.green('OK')}`;
        },
      });
      tasks.push({
        title: 'Installing marketplace dependencies',
        task: async (message) => {
          // runNpmInstallInMarketplace throws InstallAbortError on a real
          // failure (non-ERESOLVE, or ERESOLVE that --legacy-peer-deps could
          // not fix). We deliberately do NOT swallow it here — the top-level
          // handler turns it into "Installation Aborted" + exit 1.
          const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
          try {
            await runNpmInstallInMarketplace(summary);
          } finally {
            stopHeartbeat();
          }
          return `Dependencies installed ${pc.green('OK')}`;
        },
      });
    }

    await runTasks(tasks);
  }

  const failedIDEs = await setupIDEs(selectedIDEs, summary);

  // Optionally disable Claude Code's built-in auto-memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  // when the user explicitly opts in, either through the interactive prompt or
  // via --disable-auto-memory. light-mem's hook-based memory is the intended
  // source of cross-session context, but we no longer mutate settings.json silently.
  // Four-state so the summary can distinguish "wrote", "already set", "left enabled",
  // and "failed". A boolean would conflate the error path with a deliberate no-op.
  let autoMemoryStatus: 'disabled' | 'already-disabled' | 'left-enabled' | 'failed' | null = null;
  const autoMemoryChoice = await resolveClaudeAutoMemoryChoice(selectedIDEs, options);
  if (autoMemoryChoice === 'disable') {
    try {
      const wrote = disableClaudeAutoMemory();
      autoMemoryStatus = wrote ? 'disabled' : 'already-disabled';
      if (wrote) {
        log.success('Claude Code: auto-memory disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1).');
      } else {
        log.info('Claude Code: auto-memory already disabled, leaving settings.json untouched.');
      }
    } catch (error: unknown) {
      // Don't fail the install over this — WARN_CONTINUE via the central handler.
      autoMemoryStatus = 'failed';
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'auto-memory',
        phase: 'post-ide',
        cause: error,
      }, summary);
    }
  } else if (autoMemoryChoice === 'leave-enabled') {
    autoMemoryStatus = 'left-enabled';
    log.info('Claude Code: leaving native auto-memory enabled unless you explicitly opt in to disabling it.');
  }

  const autoStartSkipped = !isInteractive || options.noAutoStart;

  await runTasks([
    {
      title: 'Starting worker daemon',
      task: async (message) => {
        if (autoStartSkipped) {
          return isInteractive
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        const port = Number(getSetting('LIGHT_MEM_WORKER_PORT'));
        const marketplaceScriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
        const cacheScriptPath = join(pluginCacheDirectory(version), 'scripts', 'worker-service.cjs');
        const scriptPath = existsSync(marketplaceScriptPath) ? marketplaceScriptPath : cacheScriptPath;
        message(`Spawning worker on port ${port}...`);
        workerStartResult = await ensureWorkerStarted(port, scriptPath);
        switch (workerStartResult) {
          case 'ready':
            return `Worker ready at http://localhost:${port} ${pc.green('OK')}`;
          case 'warming':
            return `Worker starting on port ${port} — finishing in background ${pc.yellow('⏳')}`;
          case 'dead':
            return `Worker did not start — try \`npx light-mem start\` manually ${pc.yellow('!')}`;
        }
      },
    },
  ]);

  // "Installation Complete" only when no ABORT fired (we'd have thrown) AND no
  // IDE failed. Any failed IDE => "Installation Partial". Reads summary.failedIDEs
  // (which captures failures that happen AFTER bufferConsole returns), not a
  // stale local count.
  const hasFailures = summary.failedIDEs.length > 0;
  const installStatus = hasFailures ? 'Installation Partial' : 'Installation Complete';
  const summaryLines = [
    `Version:     ${pc.cyan(version)}`,
    `Plugin dir:  ${pc.cyan(marketplaceDir)}`,
    `IDEs:        ${pc.cyan(selectedIDEs.join(', '))}`,
  ];
  if (autoMemoryStatus === 'disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'already-disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('already disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'left-enabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('left enabled')} (native Claude Code memory preserved)`);
  } else if (autoMemoryStatus === 'failed') {
    summaryLines.push(`Auto-memory: ${pc.red('write failed')} (see warning above)`);
  }
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${pc.red(failedIDEs.join(', '))}`);
  }

  if (isInteractive) {
    p.note(summaryLines.join('\n'), installStatus);
  } else {
    console.log(`\n  ${installStatus}`);
    summaryLines.forEach(l => console.log(`  ${l}`));
  }

  // Flush all WARN_CONTINUE / FAIL_LOUD_PER_IDE warnings + remediation AFTER the
  // spinners and summary note (a live print would be clobbered by clack).
  flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.log(`  ${line}`)));

  const workerPort = getSetting('LIGHT_MEM_WORKER_PORT');

  let actualPort: number | string = workerPort;
  let workerReady = false;
  // Don't poll the worker or imply it's "still starting" when autostart was
  // intentionally skipped (--no-auto-start, or non-interactive default). The
  // user knows they have to start it themselves; lying about a starting worker
  // is misleading.
  if (!autoStartSkipped) {
    const healthSpinner = isInteractive ? p.spinner() : null;
    healthSpinner?.start(`Verifying worker on port ${workerPort}…`);
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthResponse.ok) {
        workerReady = true;
        try {
          const body = await healthResponse.json() as { port?: number | string };
          if (body && (typeof body.port === 'number' || typeof body.port === 'string')) {
            actualPort = body.port;
          }
        } catch {
          // Health endpoint returned non-JSON — keep using the requested port.
        }
      }
      healthSpinner?.stop(
        workerReady
          ? `Worker ready at http://localhost:${actualPort}`
          : `Worker reachable but not ready on port ${workerPort}`,
      );
    } catch {
      healthSpinner?.stop(`Worker not yet responding on port ${workerPort} (still starting)`);
    }
  }

  const finalWorkerState = workerStartResult as WorkerStartResult;
  const workerAlive = finalWorkerState !== 'dead' || workerReady;
  const runtimeLabel = 'Worker';
  const runtimeStartCommand = 'npx light-mem start';
  const workerHeadline = autoStartSkipped
    ? `${pc.yellow('!')} ${runtimeLabel} autostart skipped — start it manually with ${pc.bold(runtimeStartCommand)}`
    : workerReady || finalWorkerState === 'ready'
      ? `${pc.green('✓')} ${runtimeLabel} running at ${pc.underline(`http://localhost:${actualPort}`)}`
      : `${pc.yellow('⏳')} ${runtimeLabel} starting at ${pc.underline(`http://localhost:${actualPort}`)} — give it ~30s, then refresh`;
  const nextSteps = autoStartSkipped
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} once the worker is running, keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.light-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: LIGHT_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.light-mem will be recreated by active hooks.')}`,
      ]
    : workerAlive
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} keep that URL open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.light-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: LIGHT_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.light-mem will be recreated by active hooks.')}`,
      ]
    : [
        `${pc.yellow('!')} Worker not yet ready on port ${pc.cyan(String(workerPort))} -- still starting up; check ${pc.bold('light-mem status')} later, or start manually: ${pc.bold('npx light-mem start')}`,
        ``,
        `${pc.bold('First success:')} keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.light-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: LIGHT_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.light-mem will be recreated by active hooks.')}`,
      ];

  if (isInteractive) {
    p.note(nextSteps.join('\n'), 'Next Steps');
    if (failedIDEs.length > 0) {
      p.outro(pc.yellow('light-mem installed with some IDE setup failures.'));
    } else {
      p.outro(pc.green('light-mem installed successfully!'));
    }
  } else {
    console.log('\n  Next Steps');
    nextSteps.forEach(l => console.log(`  ${l}`));
    if (failedIDEs.length > 0) {
      console.log('\nlight-mem installed with some IDE setup failures.');
      process.exitCode = 1;
    } else {
      console.log('\nlight-mem installed successfully!');
    }
  }
}

export async function runRepairCommand(): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);

  if (isInteractive) {
    p.intro(pc.bgCyan(pc.black(' light-mem repair ')));
  } else {
    console.log('light-mem repair');
  }
  log.info(`Version: ${pc.cyan(version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Node…');
        const { version: nodeVersion } = await ensureNode();
        // Repair must regenerate the cache if it was wiped (e.g. user ran
        // `rm -rf ~/.claude/plugins/cache`). Without this, npm install would
        // fail immediately with no package.json to install against.
        if (!existsSync(join(cacheDir, 'package.json'))) {
          message('Cache missing — repopulating from npm package…');
          copyPluginToCache(version);
        }
        message('Reinstalling plugin dependencies…');
        await installPluginDependencies(cacheDir);
        writeInstallMarker(cacheDir, version, nodeVersion);
        return `Runtime ready (Node ${nodeVersion}) ${pc.green('OK')}`;
      },
    },
  ]);

  if (isInteractive) {
    p.outro(pc.green('light-mem repair complete.'));
  } else {
    console.log('light-mem repair complete.');
  }
}
