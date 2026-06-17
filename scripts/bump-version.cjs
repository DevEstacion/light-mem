#!/usr/bin/env node
/**
 * Bump the version in package.json + .claude-plugin/marketplace.json + (optional) plugin/.claude-plugin/plugin.json.
 *
 * Two modes:
 *   1. CLI mode (manual): `node scripts/bump-version.cjs [patch|minor|major]`
 *      Bumps the version in place. Run after editing source if you want a version
 *      bump without a commit (e.g. before pushing).
 *
 *   2. Pre-commit hook mode (default when stdin is not a TTY AND no arg is given):
 *      Called from .git/hooks/pre-commit. Bumps only when the staged diff for
 *      package.json does NOT already contain a version bump from this same hook
 *      invocation. Re-stages the bumped files so the bump rides into the user's
 *      commit instead of spawning a second commit.
 *
 * Idempotence: the hook reads the staged version. If the staged version already
 * differs from the prior HEAD version (i.e. someone else bumped it in this
 * branch and the hook is being re-run), it skips.
 *
 * Exit codes:
 *   0  bump applied, OR bump skipped (no-op)
 *   1  invalid usage / malformed package.json
 *   2  pre-commit hook detected that staging area is not a git repo
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const MARKETPLACE_JSON = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

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

function syncMarketplaceVersion(newVersion, description) {
  if (!fs.existsSync(MARKETPLACE_JSON)) return;
  const raw = fs.readFileSync(MARKETPLACE_JSON, 'utf8');
  const json = JSON.parse(raw);
  let dirty = false;
  for (const plugin of json.plugins || []) {
    if (plugin.version !== newVersion) {
      plugin.version = newVersion;
      dirty = true;
    }
    if (description && plugin.description !== description) {
      plugin.description = description;
      dirty = true;
    }
  }
  if (dirty) {
    fs.writeFileSync(MARKETPLACE_JSON, JSON.stringify(json, null, 2) + '\n');
  }
}

function getPriorVersionFromHead() {
  try {
    const out = execSync('git show HEAD:package.json', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return JSON.parse(out).version;
  } catch {
    // No prior commit, or this is the first commit.
    return null;
  }
}

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
  syncMarketplaceVersion(next, json.description);
  console.log(`Bumped version: ${match[0]} -> ${next}`);
}

function hookBump() {
  if (!isGitRepo()) {
    // Not a git checkout (e.g. extracted tarball in CI). Skip silently.
    process.exit(0);
  }

  const { raw, json } = readPackageJson();
  const match = SEMVER_RE.exec(json.version);
  if (!match) {
    console.error(`bump-version: cannot parse current version ${json.version}`);
    process.exit(1);
  }

  const prior = getPriorVersionFromHead();
  // If the working-tree version differs from HEAD, the bump is already in flight
  // (user ran `npm run version:bump` manually, or this hook ran on a prior
  // commit and is being re-invoked). Don't double-bump.
  if (prior !== null && prior !== json.version) {
    process.exit(0);
  }

  const next = bump(match.slice(1, 4).map(Number), 'patch');
  json.version = next;
  writePackageJson(json, raw);
  syncMarketplaceVersion(next, json.description);

  execSync('git add package.json .claude-plugin/marketplace.json', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  console.log(`pre-commit: bumped version ${match[0]} -> ${next}`);
}

const arg = process.argv[2];
if (arg) {
  cliBump(arg);
} else {
  hookBump();
}