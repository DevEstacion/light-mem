#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_CHECK_LOG_PREFIX = '[version-check]';
// Plugin runtime deps are installed with npm, which ships with every Node.
// `--omit=dev` is the npm equivalent of the old `bun install --production`.
const NPM_INSTALL_ARGS = Object.freeze(['install', '--omit=dev', '--no-audit', '--no-fund']);
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const NODE_MODULES_DIRNAME = 'node_modules';

// node:sqlite requires Node ≥ 24, whose bundled C++ headers (cppgc/macros.h)
// use C++20 `concept`/`requires`. node-gyp defaults native-addon builds to
// C++17, so tree-sitter's binding.cc fails with "unknown type name 'concept'".
// Force C++20 for the C++ compiler only — the C sources reject `-std=c++20`
// ("not allowed with 'C'"). Append so a user's existing CXXFLAGS still apply
// (clang/gcc take the last `-std`, so ours wins where it must). POSIX only:
// MSVC on Windows defaults new enough and ignores CXXFLAGS.
function npmInstallEnv() {
  if (IS_WINDOWS) return process.env;
  const existing = process.env.CXXFLAGS ? `${process.env.CXXFLAGS} ` : '';
  return { ...process.env, CXXFLAGS: `${existing}-std=c++20` };
}

// npm ships as `npm`/`npm.cmd` alongside Node; resolve via PATH. We run it
// through a shell on Windows so the `.cmd` shim resolves.
function findNpm() {
  const probe = IS_WINDOWS
    ? spawnSync('where npm', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: true })
    : spawnSync('which', ['npm'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (probe.status === 0 && probe.stdout.trim()) {
    const first = probe.stdout.split('\n').map((l) => l.trim()).find(Boolean);
    if (first) return first;
  }
  return null;
}

// Setup-phase auto-install of plugin runtime dependencies.
//
// The plugin marketplace extracts files into ~/.claude/plugins/cache/...
// but does not run `bun install`. On fresh installs the worker crashes
// with `Cannot find module 'zod/v3'` on the very first hook invocation
// (gh #2640, #2637). The previous defense-in-depth fix (gh #2644) ran
// the install on the SessionStart / UserPromptSubmit hot path; review
// (gh #2649 — YOMXXX) flagged that as the wrong architectural home
// because it makes proxy / offline / OOM failures land on the user's
// first prompt instead of at install time.
//
// Running it here at Setup keeps the install off the hot path: Setup
// has a 300s timeout (vs 60s for SessionStart), runs once per Claude
// Code launch, and is the only standalone hook script — the natural
// place to materialise plugin runtime state.
function ensurePluginDependencies(pluginRoot) {
  if (!existsSync(join(pluginRoot, 'package.json'))) return;

  // Guard on node_modules (package-manager marker) rather than a specific
  // package, so the check stays correct if dependencies are later renamed.
  if (existsSync(join(pluginRoot, NODE_MODULES_DIRNAME))) return;

  const npmPath = findNpm();
  if (!npmPath) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} npm not found on PATH; cannot auto-install plugin dependencies`);
    return;
  }

  // Progress diagnostic so users understand the (one-time) Setup hang.
  console.error(`${VERSION_CHECK_LOG_PREFIX} installing plugin dependencies (first run, one-time)...`);

  let result;
  try {
    result = spawnSync(npmPath, NPM_INSTALL_ARGS, {
      cwd: pluginRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: NPM_INSTALL_TIMEOUT_MS,
      windowsHide: true,
      shell: IS_WINDOWS, // npm is npm.cmd on Windows
      env: npmInstallEnv(), // C++20 for native addons under Node ≥ 24
    });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(`${VERSION_CHECK_LOG_PREFIX} npm install threw (${reason}); worker may crash with missing module errors`);
    return;
  }

  // spawnSync does NOT throw on a failed child. Three distinct failure
  // modes must be surfaced explicitly:
  //   1. result.error set (ENOENT / ETIMEDOUT / ...)
  //   2. non-zero exit code
  //   3. signal-killed (OOM SIGKILL, SIGTERM, ...) where result.status is
  //      null AND result.error is undefined — only result.signal is set.
  const killedBySignal = result.status === null && !!result.signal;
  const nonZeroExit = result.status !== null && result.status !== 0;
  if (result.error || nonZeroExit || killedBySignal) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (killedBySignal) {
      reason = `killed by ${result.signal}`;
    } else {
      reason = `exit ${result.status}`;
    }
    console.error(`${VERSION_CHECK_LOG_PREFIX} npm install failed (${reason}); worker may crash with missing module errors`);
    // `npm install` often creates `node_modules/` BEFORE the failure point
    // (network timeout mid-fetch, OOM kill, registry 5xx after partial
    // resolution). The existence guard above would then permanently skip
    // retry on every subsequent Setup run, leaving the plugin broken with
    // no recovery path short of manual `rm -rf node_modules`. Remove the
    // partial dir so the next Setup invocation can retry automatically
    // (gh #2650 review).
    try {
      rmSync(join(pluginRoot, NODE_MODULES_DIRNAME), { recursive: true, force: true });
    } catch (rmErr) {
      const rmReason = rmErr && rmErr.message ? rmErr.message : String(rmErr);
      console.error(`${VERSION_CHECK_LOG_PREFIX} failed to clean up partial node_modules (${rmReason}); next Setup run may skip retry`);
    }
  } else {
    // Close the diagnostic loop: a Setup hook that can block for up to
    // 120s needs an explicit completion line so users can distinguish a
    // hung install from one that finished silently (gh #2650 review).
    console.error(`${VERSION_CHECK_LOG_PREFIX} plugin dependencies installed successfully`);
  }
}

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

ensurePluginDependencies(ROOT);

function emitUpgradeHint(message) {
  if (process.env.LIGHT_MEM_CODEX_HOOK === '1') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    console.error(message);
  }
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readInstallMarkerVersion(markerPath) {
  const content = readFileSync(markerPath, 'utf-8');
  try {
    const marker = JSON.parse(content);
    return marker && typeof marker === 'object' && typeof marker.version === 'string'
      ? marker.version
      : null;
  } catch {
    const legacyVersion = content.trim();
    return LEGACY_VERSION_MARKER_RE.test(legacyVersion)
      ? legacyVersion.replace(/^v/i, '')
      : null;
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    emitUpgradeHint('light-mem: runtime not yet set up - run: npx light-mem@latest install');
    process.exit(0);
  }
  const markerVersion = readInstallMarkerVersion(markerPath);
  if (!markerVersion) {
    emitUpgradeHint('light-mem: install marker unreadable - run: npx light-mem@latest install');
  } else if (markerVersion !== pkg.version) {
    emitUpgradeHint(`light-mem: upgraded to v${pkg.version} - run: npx light-mem@latest install`);
  }
} catch {
  emitUpgradeHint('light-mem: install marker unreadable - run: npx light-mem@latest install');
}
process.exit(0);
