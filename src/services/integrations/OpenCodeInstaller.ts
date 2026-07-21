
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  readdirSync,
  rmSync,
} from 'fs';
import { logger } from '../../utils/logger.js';
import {
  CONTEXT_TAG_OPEN,
  CONTEXT_TAG_CLOSE,
  injectContextIntoMarkdownFile,
} from '../../utils/context-injection.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

const OPENCODE_NPM_PACKAGE_NAME = 'light-mem';
const OPENCODE_PLUGIN_BUNDLE_FILENAME = 'light-mem.js';
// `.bundle.mjs` (not `.js`) so OpenCode's plugin auto-loader, which scans only
// `.js` / `.ts`, does not pick it up as a second plugin entry. The shim
// (light-mem.js) is the only file the loader sees.
const OPENCODE_PLUGIN_BUNDLE_SIBLING = 'light-mem.bundle.mjs';
const OPENCODE_PLUGIN_SHIM_BODY = [
  '// light-mem OpenCode plugin entry (shim).',
  '// The full implementation lives in light-mem.bundle.js so OpenCode',
  '// shows a small annotation instead of a 50 KB minified blob.',
  'export { default, server } from "./light-mem.bundle.js";',
  '',
].join('\n');

type OpenCodeConfig = {
  $schema?: string;
  plugin?: unknown;
  [key: string]: unknown;
};

export function getOpenCodeGlobalConfigDirectory(): string {
  return path.join(homedir(), '.config', 'opencode');
}

export function getOpenCodeGlobalPluginsDirectory(): string {
  return path.join(getOpenCodeGlobalConfigDirectory(), 'plugins');
}

export function getOpenCodeGlobalConfigPath(): string {
  return path.join(getOpenCodeGlobalConfigDirectory(), 'opencode.json');
}

export function getOpenCodeGlobalPluginPath(): string {
  return path.join(getOpenCodeGlobalPluginsDirectory(), OPENCODE_PLUGIN_BUNDLE_FILENAME);
}

export function getOpenCodeGlobalOpencodeJsoncPath(): string {
  return path.join(getOpenCodeGlobalConfigDirectory(), 'opencode.jsonc');
}

export function getOpenCodeConfigDirPluginsDirectory(): string | null {
  const dir = process.env.OPENCODE_CONFIG_DIR;
  if (!dir) return null;
  return path.join(dir, 'plugins');
}

export function getOpenCodeConfigDirPluginPath(): string | null {
  const dir = getOpenCodeConfigDirPluginsDirectory();
  if (!dir) return null;
  return path.join(dir, OPENCODE_PLUGIN_BUNDLE_FILENAME);
}

export function getOpenCodeAgentsMdPath(): string {
  // The injected memory context lives in the global AGENTS.md so any project
  // started via OpenCode picks it up. The per-project AGENTS.md is left alone
  // (opencode.ai merges both via its instruction-loading pipeline).
  return path.join(getOpenCodeGlobalConfigDirectory(), 'AGENTS.md');
}

export function getInstalledPluginPath(): string {
  return getOpenCodeGlobalPluginPath();
}

function asPluginList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

function readOpenCodeConfig(configPath: string): OpenCodeConfig {
  if (!existsSync(configPath)) {
    return { $schema: 'https://opencode.ai/config.json' };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as OpenCodeConfig;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('top-level config is not an object');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse ${configPath}: ${message}`);
  }
}

function writeOpenCodeConfig(configPath: string, config: OpenCodeConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * Resolve the absolute path to the bundled `mcp-server.cjs` so the OpenCode
 * MCP block can `command: ["node", <abs path>]`. Walks the same candidate
 * chain as the OpenCode plugin: MARKETPLACE_ROOT/plugin, dev tree plugin/,
 * then the OpenCode global config dir.
 */
function resolveInstalledMcpServerPath(): string | null {
  const candidates: string[] = [];
  if (MARKETPLACE_ROOT) {
    candidates.push(path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs'));
  }
  candidates.push(path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'));
  candidates.push(
    path.join(getOpenCodeGlobalConfigDirectory(), 'plugins', 'mcp-server.cjs'),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Register an MCP search server in the global OpenCode config under
 * `mcp["light-mem:mcp-search"]`. OpenCode's plugin runtime probes for an MCP
 * server named `<plugin>:<server>` for any plugin whose name starts with
 * `light-mem` and would otherwise log `server unavailable` on every session
 * start. Even if this specific key shape isn't picked up by the runtime,
 * the MCP server remains available under the same stdio process path for
 * anything that probes the flat namespace. The plugin itself already exposes
 * `light_mem_search` as a custom tool — the MCP block is a parallel
 * search interface.
 */
const OPENCODE_MCP_SERVER_KEY = 'light-mem:mcp-search';

function registerMcpServerInGlobalConfig(): number {
  const jsonPath = getOpenCodeGlobalConfigPath();
  const jsoncPath = getOpenCodeGlobalOpencodeJsoncPath();
  const targetPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const serverPath = resolveInstalledMcpServerPath();
  if (!serverPath) {
    console.log('  MCP server: not registered (mcp-server.cjs not found)');
    return 0;
  }
  try {
    const config = readOpenCodeConfig(targetPath);
    const mcpBlock =
      (config as { mcp?: Record<string, unknown> }).mcp ?? {};
    if (mcpBlock[OPENCODE_MCP_SERVER_KEY]) {
      return 0;
    }
    (config as { mcp?: Record<string, unknown> }).mcp = {
      ...mcpBlock,
      [OPENCODE_MCP_SERVER_KEY]: {
        type: 'local',
        command: ['node', serverPath],
        enabled: true,
      },
    };
    writeOpenCodeConfig(targetPath, config);
    console.log(
      `  MCP server registered: ${OPENCODE_MCP_SERVER_KEY} → ${serverPath}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to register OpenCode MCP server: ${message}`);
    return 1;
  }
}

function deregisterMcpServerFromGlobalConfig(): number {
  const jsonPath = getOpenCodeGlobalConfigPath();
  const jsoncPath = getOpenCodeGlobalOpencodeJsoncPath();
  const targetPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  if (!existsSync(targetPath)) return 0;
  try {
    const config = readOpenCodeConfig(targetPath);
    const mcpBlock =
      (config as { mcp?: Record<string, unknown> }).mcp;
    if (!mcpBlock || !mcpBlock[OPENCODE_MCP_SERVER_KEY]) return 0;
    delete mcpBlock[OPENCODE_MCP_SERVER_KEY];
    if (Object.keys(mcpBlock).length === 0) {
      delete (config as { mcp?: Record<string, unknown> }).mcp;
    } else {
      (config as { mcp?: Record<string, unknown> }).mcp = mcpBlock;
    }
    writeOpenCodeConfig(targetPath, config);
    console.log(`  MCP server deregistered: ${OPENCODE_MCP_SERVER_KEY}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deregister OpenCode MCP server: ${message}`);
    return 1;
  }
}

function hasNpmPluginEntry(config: OpenCodeConfig, packageName: string): boolean {
  return asPluginList(config.plugin).some(
    (entry) => entry === packageName || entry.startsWith(`${packageName}@`),
  );
}

export function addOpenCodeNpmPluginReference(config: OpenCodeConfig): OpenCodeConfig {
  if (hasNpmPluginEntry(config, OPENCODE_NPM_PACKAGE_NAME)) {
    return config;
  }
  return {
    ...config,
    plugin: [...asPluginList(config.plugin), OPENCODE_NPM_PACKAGE_NAME],
  };
}

export function removeOpenCodeNpmPluginReference(config: OpenCodeConfig): OpenCodeConfig {
  return {
    ...config,
    plugin: asPluginList(config.plugin).filter(
      (entry) => entry !== OPENCODE_NPM_PACKAGE_NAME && !entry.startsWith(`${OPENCODE_NPM_PACKAGE_NAME}@`),
    ),
  };
}

/**
 * Strip any stale `light-mem` (or `light-mem@…`) entry from the user's
 * `opencode.json` / `opencode.jsonc` `plugin` array. The local shim at
 * `~/.config/opencode/plugins/light-mem.js` is the single source of truth;
 * the npm package is only used for `npx light-mem start` (the worker).
 */
function stripNpmPluginEntryFromGlobalConfig(): number {
  const jsonPath = getOpenCodeGlobalConfigPath();
  const jsoncPath = getOpenCodeGlobalOpencodeJsoncPath();
  const targetPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  if (!existsSync(targetPath)) return 0;
  try {
    const config = readOpenCodeConfig(targetPath);
    const plugins = asPluginList(config.plugin);
    const filtered = plugins.filter(
      (entry) => entry !== OPENCODE_NPM_PACKAGE_NAME && !entry.startsWith(`${OPENCODE_NPM_PACKAGE_NAME}@`),
    );
    if (filtered.length === plugins.length) return 0;
    (config as { plugin?: unknown }).plugin = filtered;
    writeOpenCodeConfig(targetPath, config);
    console.log(`  Stripped npm plugin entry from: ${targetPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to strip npm plugin entry: ${message}`);
    return 1;
  }

  // Also wipe any stale light-mem packages from OpenCode's npm cache so
  // OpenCode doesn't fall back to the old bundle from a previous install.
  wipeStaleLightMemFromOpencodeCache();
  return 0;
}

function wipeStaleLightMemFromOpencodeCache(): void {
  const cacheDir = path.join(getOpenCodeGlobalConfigDirectory(), '..', 'cache', 'opencode', 'packages');
  if (!existsSync(cacheDir)) return;
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (entry === OPENCODE_NPM_PACKAGE_NAME || entry.startsWith(`${OPENCODE_NPM_PACKAGE_NAME}@`)) {
        rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
        console.log(`  Removed stale cached package: ${entry}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Could not wipe stale cached packages: ${message}`);
  }
}

function registerNpmPluginInGlobalConfig(): number {
  const jsonPath = getOpenCodeGlobalConfigPath();
  const jsoncPath = getOpenCodeGlobalOpencodeJsoncPath();
  // Prefer editing opencode.jsonc (the newer canonical filename) when present
  // so we don't fight the user's comment-stripped sibling file. Fall back to
  // opencode.json for users who only have the legacy file.
  const targetPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;

  try {
    const config = readOpenCodeConfig(targetPath);
    if (hasNpmPluginEntry(config, OPENCODE_NPM_PACKAGE_NAME)) {
      console.log(`  Plugin already registered in: ${targetPath}`);
      return 0;
    }
    const updated = addOpenCodeNpmPluginReference(config);
    writeOpenCodeConfig(targetPath, updated);
    console.log(`  Plugin registered in: ${targetPath}`);
    logger.info('OPENCODE', 'Plugin registered in config', { path: targetPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to register OpenCode plugin in config: ${message}`);
    return 1;
  }
}

function deregisterNpmPluginFromGlobalConfig(): number {
  const jsonPath = getOpenCodeGlobalConfigPath();
  const jsoncPath = getOpenCodeGlobalOpencodeJsoncPath();
  const targetPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;

  if (!existsSync(targetPath)) {
    return 0;
  }

  try {
    const config = readOpenCodeConfig(targetPath);
    const updated = removeOpenCodeNpmPluginReference(config);
    writeOpenCodeConfig(targetPath, updated);
    console.log(`  Plugin deregistered from: ${targetPath}`);
    logger.info('OPENCODE', 'Plugin deregistered from config', { path: targetPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deregister OpenCode plugin from config: ${message}`);
    return 1;
  }
}

function copyPluginBundleTo(destinationDir: string): number {
  if (!existsSync(destinationDir)) {
    mkdirSync(destinationDir, { recursive: true });
  }
  const builtPluginPath = findBuiltPluginPath();
  if (!builtPluginPath) {
    console.error('Could not find built OpenCode plugin bundle.');
    console.error('  Expected at: dist/opencode-plugin/index.js');
    console.error('  Run the build first: npm run build');
    return 1;
  }

  // Copy the heavy implementation as `light-mem.bundle.js` and write a tiny
  // shim `light-mem.js` that re-exports from it. OpenCode renders the plugin
  // file as a UI annotation; a 50 KB minified blob there is unreadable.
  const bundleDestinationPath = path.join(
    destinationDir,
    OPENCODE_PLUGIN_BUNDLE_SIBLING,
  );
  const shimDestinationPath = path.join(
    destinationDir,
    OPENCODE_PLUGIN_BUNDLE_FILENAME,
  );
  copyFileSync(builtPluginPath, bundleDestinationPath);
  writeFileSync(shimDestinationPath, OPENCODE_PLUGIN_SHIM_BODY);
  console.log(`  Plugin bundle copied to: ${bundleDestinationPath}`);
  console.log(`  Plugin shim written to:  ${shimDestinationPath}`);
  logger.info('OPENCODE', 'Plugin bundle + shim copied', {
    bundle: bundleDestinationPath,
    shim: shimDestinationPath,
  });
  return 0;
}

function findBuiltPluginPath(): string | null {
  // The heavy implementation lives in `light-mem.bundle.js` next to the
  // small `light-mem.js` shim. Look for the bundle, not the shim — copying
  // the shim as the bundle would replace a 330 KB file with a 230 B file.
  const possiblePaths = [
    // Installed marketplace copy — plugin tree (build emits here)
    path.join(MARKETPLACE_ROOT, 'plugin', 'integrations', 'opencode', OPENCODE_PLUGIN_BUNDLE_SIBLING),
    // Installed marketplace copy — legacy dist layout
    path.join(MARKETPLACE_ROOT, 'dist', 'opencode-plugin', 'index.js'),
    // Dev-tree checkout (repo root)
    path.join(process.cwd(), 'plugin', 'integrations', 'opencode', OPENCODE_PLUGIN_BUNDLE_SIBLING),
    path.join(process.cwd(), 'dist', 'opencode-plugin', 'index.js'),
    // Relative to this compiled file (fallback)
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'dist',
      'opencode-plugin',
      'index.js',
    ),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function tryNpmInstallGlobal(): boolean {
  // Delegate to OpenCode's own installer when available. It pins the npm
  // package version, populates ~/.cache/opencode/packages/, and adds the
  // plugin entry to the global config in one step. We swallow failures
  // (e.g. opencode binary not on PATH) and fall back to the manual copy.
  try {
    execFileSync('opencode', ['plugin', 'install', OPENCODE_NPM_PACKAGE_NAME, '--global'], {
      stdio: 'pipe',
      timeout: 120_000,
    });
    console.log(`  Ran: opencode plugin install ${OPENCODE_NPM_PACKAGE_NAME} --global`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('OPENCODE', 'opencode plugin install --global failed; falling back to manual install', {}, error instanceof Error ? error : new Error(message));
    return false;
  }
}

export function installOpenCodePlugin(): number {
  // Single source of truth: the local shim at ~/.config/opencode/plugins/.
  //
  // Earlier versions ALSO added a "light-mem" entry to opencode.json's
  // `plugin` array, which made OpenCode install the npm package AND load
  // the shim — two copies of the same plugin. Each tool run then fired
  // BOTH, producing duplicate PostToolUse hooks in the UI. Keeping only
  // the local shim means: one install path, one plugin entry, one
  // observation per tool. The npm package is still useful for `npx
  // light-mem start` (the worker) but is not loaded as an OpenCode plugin.
  //
  // If the user has a stale npm entry from a prior install, strip it so
  // the next run only loads the shim.
  stripNpmPluginEntryFromGlobalConfig();

  // Remove the legacy single-file install location. Pre-shim copies landed in
  // ~/.config/opencode/plugin/light-mem.js, and OpenCode auto-loads BOTH the
  // legacy `plugin/` dir and the new `plugins/` dir, which would log twice.
  removeLegacySingleFileInstall();

  const globalCopyResult = copyPluginBundleTo(getOpenCodeGlobalPluginsDirectory());
  if (globalCopyResult !== 0) {
    return globalCopyResult;
  }

  const configDirPlugins = getOpenCodeConfigDirPluginsDirectory();
  if (configDirPlugins) {
    const configDirCopyResult = copyPluginBundleTo(configDirPlugins);
    if (configDirCopyResult !== 0) {
      return configDirCopyResult;
    }
  }

  // Register the MCP search server so OpenCode doesn't log
  // `server unavailable key=light-mem:mcp-search` on every session start.
  const mcpResult = registerMcpServerInGlobalConfig();
  if (mcpResult !== 0) {
    return mcpResult;
  }

  return 0;
}

export function injectContextIntoAgentsMd(contextContent: string): number {
  const agentsMdPath = getOpenCodeAgentsMdPath();

  try {
    injectContextIntoMarkdownFile(agentsMdPath, contextContent, '# Light-Mem Memory Context');
    logger.info('OPENCODE', 'Context injected into AGENTS.md', { path: agentsMdPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to inject context into AGENTS.md: ${message}`);
    return 1;
  }
}

export async function syncContextToAgentsMd(
  port: number,
  project: string,
): Promise<void> {
  try {
    await fetchAndInjectOpenCodeContext(port, project);
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not available during context sync', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not available during context sync', {}, new Error(String(error)));
    }
  }
}

async function fetchRealContextFromWorker(): Promise<string | null> {
  const workerPort = getWorkerPort();
  const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/api/readiness`);
  if (!healthResponse.ok) return null;

  const contextResponse = await fetch(
    `http://127.0.0.1:${workerPort}/api/context/inject?project=opencode`,
  );
  if (!contextResponse.ok) return null;

  const realContext = await contextResponse.text();
  return realContext && realContext.trim() ? realContext : null;
}

async function fetchAndInjectOpenCodeContext(port: number, project: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`,
  );
  if (!response.ok) return;

  const contextText = await response.text();
  if (contextText && contextText.trim()) {
    const injectResult = injectContextIntoAgentsMd(contextText);
    if (injectResult !== 0) {
      logger.warn('OPENCODE', 'Failed to inject context into AGENTS.md during sync');
    }
  }
}

function writeOrRemoveCleanedAgentsMd(agentsMdPath: string, trimmedContent: string): void {
  if (
    trimmedContent.length === 0 ||
    trimmedContent === '# Light-Mem Memory Context'
  ) {
    unlinkSync(agentsMdPath);
    console.log(`  Removed empty AGENTS.md`);
  } else {
    writeFileSync(agentsMdPath, trimmedContent + '\n', 'utf-8');
    console.log(`  Cleaned context from AGENTS.md`);
  }
}

function removePluginBundleFrom(destinationDir: string): void {
  const destinationPath = path.join(destinationDir, OPENCODE_PLUGIN_BUNDLE_FILENAME);
  if (existsSync(destinationPath)) {
    unlinkSync(destinationPath);
    console.log(`  Removed plugin bundle: ${destinationPath}`);
  }
}

/**
 * Older light-mem versions dropped a single `light-mem.js` into
 * `~/.config/opencode/plugin/` (singular). OpenCode auto-loads files in BOTH
 * the legacy `plugin/` and the new `plugins/` directories, so a leftover
 * legacy file made light-mem log twice on every session start. Clear it.
 */
function removeLegacySingleFileInstall(): void {
  const legacyDir = path.join(getOpenCodeGlobalConfigDirectory(), 'plugin');
  const legacyPath = path.join(legacyDir, OPENCODE_PLUGIN_BUNDLE_FILENAME);
  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
    console.log(`  Removed legacy single-file install: ${legacyPath}`);
  }
}

export function uninstallOpenCodePlugin(): number {
  let hasErrors = false;

  removePluginBundleFrom(getOpenCodeGlobalPluginsDirectory());

  const configDirPlugins = getOpenCodeConfigDirPluginsDirectory();
  if (configDirPlugins) {
    removePluginBundleFrom(configDirPlugins);
  }

  if (deregisterNpmPluginFromGlobalConfig() !== 0) {
    hasErrors = true;
  }

  if (deregisterMcpServerFromGlobalConfig() !== 0) {
    hasErrors = true;
  }

  removeLegacySingleFileInstall();

  const agentsMdPath = getOpenCodeAgentsMdPath();
  if (existsSync(agentsMdPath)) {
    let content: string;
    try {
      content = readFileSync(agentsMdPath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to read AGENTS.md: ${message}`);
      hasErrors = true;
      content = '';
    }

    const tagStartIndex = content.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = content.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      content =
        content.slice(0, tagStartIndex).trimEnd() +
        '\n' +
        content.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length).trimStart();

      const trimmedContent = content.trim();
      try {
        writeOrRemoveCleanedAgentsMd(agentsMdPath, trimmedContent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Failed to clean AGENTS.md: ${message}`);
        hasErrors = true;
      }
    }
  }

  return hasErrors ? 1 : 0;
}

export function checkOpenCodeStatus(): number {
  console.log('\nLight-Mem OpenCode Integration Status\n');

  const configDirectory = getOpenCodeGlobalConfigDirectory();
  const globalPluginPath = getOpenCodeGlobalPluginPath();
  const configDirPlugins = getOpenCodeConfigDirPluginsDirectory();
  const configDirPluginPath = getOpenCodeConfigDirPluginPath();
  const agentsMdPath = getOpenCodeAgentsMdPath();

  console.log(`Config directory: ${configDirectory}`);
  console.log(`  Exists: ${existsSync(configDirectory) ? 'yes' : 'no'}`);
  console.log(`OPENCODE_CONFIG_DIR: ${process.env.OPENCODE_CONFIG_DIR ?? '(unset)'}`);
  console.log('');

  console.log(`Global plugin bundle: ${globalPluginPath}`);
  console.log(`  Installed: ${existsSync(globalPluginPath) ? 'yes' : 'no'}`);
  console.log('');

  if (configDirPlugins && configDirPluginPath) {
    console.log(`OPENCODE_CONFIG_DIR plugin bundle: ${configDirPluginPath}`);
    console.log(`  Installed: ${existsSync(configDirPluginPath) ? 'yes' : 'no'}`);
    console.log('');
  }

  const configPath = existsSync(getOpenCodeGlobalOpencodeJsoncPath())
    ? getOpenCodeGlobalOpencodeJsoncPath()
    : getOpenCodeGlobalConfigPath();
  if (existsSync(configPath)) {
    try {
      const config = readOpenCodeConfig(configPath);
      const plugins = asPluginList(config.plugin);
      console.log(`Config file: ${configPath}`);
      console.log(`  "light-mem" in plugin array: ${hasNpmPluginEntry(config, OPENCODE_NPM_PACKAGE_NAME) ? 'yes' : 'no'}`);
      console.log(`  All plugins: ${plugins.length === 0 ? '(none)' : plugins.join(', ')}`);
    } catch (error) {
      console.log(`Config file: ${configPath}`);
      console.log(`  Could not read: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log(`Config file: ${configPath}`);
    console.log(`  Exists: no`);
  }
  console.log('');

  console.log(`Context (AGENTS.md): ${agentsMdPath}`);
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    const hasContextTags = content.includes(CONTEXT_TAG_OPEN);
    console.log(`  Exists: yes`);
    console.log(`  Has light-mem context: ${hasContextTags ? 'yes' : 'no'}`);
  } else {
    console.log(`  Exists: no`);
  }

  console.log('');
  return 0;
}

export async function installOpenCodeIntegration(): Promise<number> {
  console.log('\nInstalling Light-Mem for OpenCode...\n');

  const pluginResult = installOpenCodePlugin();
  if (pluginResult !== 0) {
    return pluginResult;
  }

  const placeholderContext = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use light-mem search tools for manual memory queries.`;

  let contextToInject = placeholderContext;
  let contextSource = 'placeholder';
  try {
    const realContext = await fetchRealContextFromWorker();
    if (realContext) {
      contextToInject = realContext;
      contextSource = 'existing memory';
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not available during OpenCode install', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not available during OpenCode install', {}, new Error(String(error)));
    }
  }

  const injectResult = injectContextIntoAgentsMd(contextToInject);
  if (injectResult !== 0) {
    logger.warn('OPENCODE', `Failed to inject ${contextSource} context into AGENTS.md during install`);
  } else {
    if (contextSource === 'existing memory') {
      console.log('  Context injected from existing memory');
    } else {
      console.log('  Placeholder context created (worker not running)');
    }
  }

  console.log(`
Installation complete!

Global plugin bundle:  ${getOpenCodeGlobalPluginPath()}
Global config:         ${existsSync(getOpenCodeGlobalOpencodeJsoncPath()) ? getOpenCodeGlobalOpencodeJsoncPath() : getOpenCodeGlobalConfigPath()}
${process.env.OPENCODE_CONFIG_DIR ? `OPENCODE_CONFIG_DIR bundle: ${getOpenCodeConfigDirPluginPath() ?? ''}` : ''}
Context file:          ${getOpenCodeAgentsMdPath()}

Next steps:
  1. Make sure the worker is running: npx light-mem start
  2. Restart OpenCode to load the plugin (or it will pick up automatically)
  3. Memory capture is automatic from then on
`);
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    console.log(`Note: OPENCODE_CONFIG_CONTENT is set, so OpenCode merges it with the global
config. The "light-mem" plugin entry in the global config will still be loaded.
If your toolchain shadows the global config (e.g. ocx), restart OpenCode once
after install so the plugin loader re-scans ~/.config/opencode/plugins/.`);
  }

  return 0;
}
