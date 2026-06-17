#!/usr/bin/env node
/**
 * Two modes:
 *   1. CLI mode (explicit bump): `node scripts/bump-version.cjs [patch|minor|major]`
 *      Bumps package.json and propagates the new version into every derived
 *      manifest via sync-plugin-manifests.js. Wired as `npm run version:bump`.
 *      Run `npm run build` afterward so the build-time-injected version in the
 *      bundled .cjs files (worker-service.cjs / Server) matches too.
 *
 *   2. Pre-commit hook mode (default when no arg is given):
 *      Called from .git/hooks/pre-commit. Does NOT bump — it VERIFIES that the
 *      version is consistent across every source and blocks the commit on drift.
 *      The build (npm run build) is the single propagation point; the hook is
 *      the guard that the build was actually run. This avoids the trap where a
 *      JSON-only bump leaves the build-time version baked into the .cjs stale,
 *      which makes the worker recycle itself on every hook (see
 *      tests/infrastructure/version-consistency.test.ts and the worker
 *      recycle check in src/shared/worker-utils.ts).
 *
 * Exit codes:
 *   0  CLI bump applied, OR hook verification passed (versions consistent)
 *   1  invalid usage / malformed package.json / version drift (commit blocked)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const SYNC_MANIFESTS = path.join(__dirname, 'sync-plugin-manifests.js');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]*)?$/;

function bump(parsed, type) {
  let [major, minor, patch] = parsed;
  switch (type) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'patch':
      patch += 1;
      break;
    default:
      throw new Error(`Unknown bump type: ${type}`);
  }
  return `${major}.${minor}.${patch}`;
}

function readPackageJson() {
  const raw = fs.readFileSync(PACKAGE_JSON, 'utf8');
  return { raw, json: JSON.parse(raw) };
}

function writePackageJson(json, raw) {
  // Preserve trailing newline if the original had one.
  const trailing = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(json, null, 2) + trailing);
}

// Propagate the just-written package.json version into every derived manifest
// (.claude-plugin/plugin.json, plugin/.claude-plugin/plugin.json,
// .claude-plugin/marketplace.json, plugin/package.json). Delegating to the
// single sync script keeps one source of propagation logic — the hook and
// `npm run build` can never write a different subset of files and drift.
function syncDerivedManifests() {
  execSync(`node ${JSON.stringify(SYNC_MANIFESTS)}`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

// Files derived from package.json's version. Kept in one place so cliBump and
// hookVerify check the identical set.
//
// FLAT_VERSION_FILES carry the version as a top-level "version" field.
// marketplace.json is separate: its versions live under plugins[].version.
const FLAT_VERSION_FILES = [
  '.claude-plugin/plugin.json',
  'plugin/.claude-plugin/plugin.json',
  'plugin/package.json',
];
const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';

function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// Read the top-level "version" field out of a JSON manifest, null if absent.
function jsonVersion(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, 'utf8')).version ?? null;
}

// Return any plugins[].version in marketplace.json that differs from expected
// (marketplace versions are nested, not a top-level field).
function marketplaceDrift(expected) {
  const abs = path.join(REPO_ROOT, MARKETPLACE_FILE);
  if (!fs.existsSync(abs)) return [`${MARKETPLACE_FILE}: (missing)`];
  const plugins = JSON.parse(fs.readFileSync(abs, 'utf8')).plugins || [];
  return plugins
    .filter((p) => p.version !== expected)
    .map((p) => `${MARKETPLACE_FILE} [${p.name}]: ${p.version ?? '(missing)'}`);
}

// The bundled worker .cjs files have the version injected at build time
// (__DEFAULT_PACKAGE_VERSION__ → "x.y.z"). The worker serves this on
// GET /api/health, and the recycle check compares it to the marketplace
// version — so a stale .cjs version is exactly what wedges the worker. Scan
// for the expected literal so the hook fails when the build wasn't re-run.
function builtCjsHasVersion(relPath, version) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return null; // not built — not a drift signal
  return fs.readFileSync(abs, 'utf8').includes(`"${version}"`);
}

function cliBump(type) {
  if (!['patch', 'minor', 'major'].includes(type)) {
    console.error(`Usage: node scripts/bump-version.cjs [patch|minor|major]`);
    process.exit(1);
  }
  const { raw, json } = readPackageJson();
  const match = SEMVER_RE.exec(json.version);
  if (!match) {
    console.error(`Cannot parse current version: ${json.version}`);
    process.exit(1);
  }
  const next = bump(match.slice(1, 4).map(Number), type);
  json.version = next;
  writePackageJson(json, raw);
  syncDerivedManifests();
  console.log(`Bumped version: ${match[0]} -> ${next}`);
}

// Built .cjs files whose version is injected at build time. Checked only if
// present (a fresh checkout before `npm run build` has none).
const BUILT_CJS_FILES = [
  'plugin/scripts/worker-service.cjs',
];

function hookVerify() {
  if (!isGitRepo()) {
    // Not a git checkout (e.g. extracted tarball in CI). Nothing to guard.
    process.exit(0);
  }

  const { json } = readPackageJson();
  const expected = json.version;
  if (!SEMVER_RE.exec(expected)) {
    console.error(`bump-version: cannot parse package.json version ${expected}`);
    process.exit(1);
  }

  const drift = [];

  for (const rel of FLAT_VERSION_FILES) {
    const v = jsonVersion(rel);
    if (v !== expected) drift.push(`  ${rel}: ${v ?? '(missing)'} (expected ${expected})`);
  }

  for (const line of marketplaceDrift(expected)) {
    drift.push(`  ${line} (expected ${expected})`);
  }

  for (const rel of BUILT_CJS_FILES) {
    const ok = builtCjsHasVersion(rel, expected);
    if (ok === false) drift.push(`  ${rel}: version ${expected} not found in bundle (stale build)`);
  }

  if (drift.length > 0) {
    console.error('bump-version: version drift — commit blocked.\n' + drift.join('\n'));
    console.error('\nFix: run `npm run build` to re-propagate the version, then re-stage.');
    process.exit(1);
  }
}

const arg = process.argv[2];
if (arg) {
  cliBump(arg);
} else {
  hookVerify();
}