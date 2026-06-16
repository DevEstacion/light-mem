import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { exec, execSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { ErrorSeverity } from './error-taxonomy.js';
import { installerError, type InstallSummary } from './error-reporter.js';

const IS_WINDOWS = process.platform === 'win32';

const INSTALL_TIMEOUT_MS = (() => {
  const override = process.env.LIGHT_MEM_INSTALL_TIMEOUT_MS;
  if (override && Number.isFinite(Number(override))) return Number(override);
  return 5 * 60 * 1000;
})();


interface MarkerSchema {
  version: string;
  bun?: string;
  installedAt?: string;
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function markerPath(targetDir: string): string {
  return join(targetDir, '.install-version');
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5; // node:sqlite landed in Node 22.5

function parseNodeVersion(s: string | undefined): { major: number; minor: number } | null {
  const m = /v?(\d+)\.(\d+)\.\d+/.exec((s || '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function nodeVersionOk(v: { major: number; minor: number }): boolean {
  return v.major > MIN_NODE_MAJOR || (v.major === MIN_NODE_MAJOR && v.minor >= MIN_NODE_MINOR);
}

/**
 * Locate a Node ≥ 22.5: the current process if new enough, else the highest
 * nvm-installed version, else known install paths / PATH. Mirrors the runtime
 * discovery in plugin/scripts/node-runner.js.
 */
function findModernNode(): { path: string; version: string } | null {
  const current = parseNodeVersion(process.version);
  if (current && nodeVersionOk(current)) {
    return { path: process.execPath, version: process.version.replace(/^v/, '') };
  }

  try {
    const nvmNodeDir = join(homedir(), '.nvm', 'versions', 'node');
    if (existsSync(nvmNodeDir)) {
      const candidates = readdirSync(nvmNodeDir)
        .map(name => ({ name, v: parseNodeVersion(name) }))
        .filter((c): c is { name: string; v: { major: number; minor: number } } => !!c.v && nodeVersionOk(c.v))
        .sort((a, b) => (b.v.major - a.v.major) || (b.v.minor - a.v.minor));
      for (const c of candidates) {
        const p = join(nvmNodeDir, c.name, 'bin', IS_WINDOWS ? 'node.exe' : 'node');
        if (existsSync(p)) return { path: p, version: c.name.replace(/^v/, '') };
      }
    }
  } catch {
    // fall through
  }

  const known = IS_WINDOWS
    ? ['C:/Program Files/nodejs/node.exe']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const p of known) {
    if (!existsSync(p)) continue;
    try {
      const r = spawnSync(p, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const v = parseNodeVersion(r.stdout);
      if (r.status === 0 && v && nodeVersionOk(v)) return { path: p, version: r.stdout.trim().replace(/^v/, '') };
    } catch {
      // try next
    }
  }
  return null;
}

export function platformNodeRemediation(): string {
  return IS_WINDOWS
    ? '  - Install Node 24+: winget install OpenJS.NodeJS\n  - Or via nvm-windows, then re-run `npx light-mem install`.'
    : '  - Install Node 24+: nvm install 24 (or brew install node)\n  - Then re-run `npx light-mem install`.';
}

function describeExecError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    if (stderr) parts.push(`stderr: ${stderr}`);
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    if (!stderr && stdout) parts.push(`stdout: ${stdout}`);
    return parts.join('\n');
  }
  return String(error);
}

/**
 * Subpath imports the bundled worker requires transitively (via
 * @modelcontextprotocol/sdk / @anthropic-ai/claude-agent-sdk). A stale/partial
 * install can leave the `zod` directory present while these subpath exports fail
 * to resolve — surfacing later as a runtime `Cannot find module 'zod/v3'`. We
 * assert them at install time so a broken closure fails LOUD here. Version-agnostic:
 * we resolve subpaths, never a pinned version.
 */
const ZOD_REQUIRED_SUBPATHS = ['zod/v3', 'zod/v4', 'zod/v4-mini'] as const;

export function verifyCriticalModules(targetDir: string): void {
  const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const nodeModulesPath = join(targetDir, 'node_modules');
  // A require anchored inside the install tree so require.resolve honors the
  // installed package.json `exports` map for subpath resolution.
  const requireFromTarget = createRequire(join(nodeModulesPath, 'noop.js'));
  const resolvePaths = [nodeModulesPath];

  const unresolvable: string[] = [];

  // Each declared dependency must be installed, not merely a directory on disk.
  for (const dep of dependencies) {
    try {
      requireFromTarget.resolve(dep, { paths: resolvePaths });
    } catch {
      // Bare-name resolution can fail for a perfectly-installed package that has
      // no importable entry point — e.g. bin-only packages like `tree-sitter-cli`
      // (package.json has `bin` but no `main`/`module`/`exports`/`index.js`).
      // Fall back to resolving its package.json to distinguish "installed but
      // bin-only" from "genuinely missing": a truly absent package fails both.
      // This preserves the original "is it installed" guarantee while still
      // upgrading from directory-existence to real module resolution (#2730).
      try {
        requireFromTarget.resolve(`${dep}/package.json`, { paths: resolvePaths });
      } catch {
        unresolvable.push(dep);
      }
    }
  }

  // zod ships its public API behind subpath exports the worker bundle requires.
  // The package dir existing does NOT imply these subpaths resolve (#2730).
  if (dependencies.includes('zod')) {
    for (const subpath of ZOD_REQUIRED_SUBPATHS) {
      try {
        requireFromTarget.resolve(subpath, { paths: resolvePaths });
      } catch {
        unresolvable.push(subpath);
      }
    }
  }

  if (unresolvable.length > 0) {
    throw new Error(
      `Post-install check failed: unresolvable modules: ${unresolvable.join(', ')}`,
    );
  }
}

/** Build an ephemeral summary so callers (e.g. repair) may omit it. */
function summaryOrEphemeral(summary?: InstallSummary): InstallSummary {
  return summary ?? { warnings: [], failedIDEs: [], retryCount: {} };
}

/**
 * Verify a Node runtime new enough for the worker's `node:sqlite` dependency
 * (Node ≥ 22.5; unflagged from 24). This does NOT auto-install a runtime —
 * installing Node is heavyweight and environment-specific (nvm/brew/system),
 * so we detect-and-instruct instead of curl-piping.
 */
export async function ensureNode(summary?: InstallSummary): Promise<{ nodePath: string; version: string }> {
  const sum = summaryOrEphemeral(summary);
  const node = findModernNode();
  if (!node) {
    installerError(ErrorSeverity.ABORT, {
      component: 'node-runtime',
      phase: 'setup-runtime',
      cause: new Error(
        `Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (the worker uses the built-in node:sqlite module).`
      ),
      remediation: platformNodeRemediation(),
    }, sum);
    throw new Error('unreachable'); // installerError(ABORT) always throws
  }
  return { nodePath: node.path, version: node.version };
}

/** uv is no longer required — vector search is now in-process. Kept as a no-op so install.ts callers compile. */

export async function installPluginDependencies(targetDir: string): Promise<void> {
  if (!existsSync(join(targetDir, 'package.json'))) {
    throw new Error(`installPluginDependencies: no package.json at ${targetDir}`);
  }

  try {
    // --ignore-scripts: tree-sitter-swift's nested tree-sitter-cli postinstall
    // downloads a Rust binary and can hang the install — skip lifecycle scripts
    // and bound it with a timeout. --omit=dev installs only the runtime closure.
    // Async exec (not execSync): a blocked event loop freezes the installer's
    // clack spinner for the duration of the install, which reads as a stall.
    await new Promise<void>((resolve, reject) => {
      exec('npm install --omit=dev --ignore-scripts --no-audit --no-fund', {
        cwd: targetDir,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
      }, (error, stdout, stderr) =>
        // exec errors don't carry stdio; attach so describeExecError can report it.
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve());
    });
  } catch (error) {
    throw new Error(`npm install failed in ${targetDir}\n${describeExecError(error)}`);
  }

  verifyCriticalModules(targetDir);
}

export function readInstallMarker(targetDir: string): MarkerSchema | null {
  const path = markerPath(targetDir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  try {
    const marker = JSON.parse(content);
    if (marker && typeof marker === 'object' && typeof marker.version === 'string') {
      return marker as MarkerSchema;
    }
  } catch {
    // Legacy installs wrote only the version string as plain text.
  }

  const legacyVersion = content.trim();
  if (LEGACY_VERSION_MARKER_RE.test(legacyVersion)) {
    return { version: legacyVersion.replace(/^v/i, '') };
  }

  return null;
}

export function writeInstallMarker(
  targetDir: string,
  version: string,
  bunVersion: string,
  _uvVersion?: string,
): void {
  const payload: MarkerSchema = {
    version,
    bun: bunVersion,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(markerPath(targetDir), JSON.stringify(payload));
}

export function isInstallCurrent(targetDir: string, expectedVersion: string): boolean {
  if (!existsSync(join(targetDir, 'node_modules'))) return false;
  const marker = readInstallMarker(targetDir);
  if (!marker) return false;
  if (marker.version !== expectedVersion) return false;
  // The `bun` marker field now records the resolved Node runtime version
  // (field name kept for marker-format stability). A runtime change since the
  // last install invalidates the cached install so native/bundled deps reload.
  const node = findModernNode();
  const currentRuntime = node?.version ?? null;
  if (currentRuntime && !marker.bun) return false;
  if (!currentRuntime && marker.bun) return false;
  if (currentRuntime && marker.bun && currentRuntime !== marker.bun) return false;
  return true;
}
