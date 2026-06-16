#!/usr/bin/env node
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';

const __node_runner_dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__node_runner_dirname, '..');

function fixBrokenScriptPath(argPath) {
  if (argPath.startsWith('/scripts/') && !existsSync(argPath)) {
    const fixedPath = join(RESOLVED_PLUGIN_ROOT, argPath);
    if (existsSync(fixedPath)) {
      return fixedPath;
    }
  }
  return argPath;
}

// The worker needs `node:sqlite`, which is built into Node ≥ 22.5 (unflagged
// from Node 24). Claude Code often launches hooks under an older PATH Node
// (e.g. an nvm default pinned to v20), so this launcher locates a new-enough
// Node and re-spawns the worker under it.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5; // node:sqlite landed in 22.5

function nodeVersionOk(major, minor) {
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

function parseNodeVersion(versionString) {
  const m = /v?(\d+)\.(\d+)\.\d+/.exec((versionString || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function probeNodeVersion(nodePath) {
  try {
    const r = spawnSync(nodePath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) return parseNodeVersion(r.stdout);
  } catch {
    /* fall through */
  }
  return null;
}

function findModernNode() {
  // 1. The Node already running this launcher — use it if it's new enough
  //    (avoids a re-spawn entirely on machines whose default Node is current).
  const current = parseNodeVersion(process.version);
  if (current && nodeVersionOk(current.major, current.minor)) {
    return process.execPath;
  }

  // 2. Highest nvm-installed Node ≥ 22.5 (covers the common "default is old" case).
  try {
    const nvmNodeDir = join(homedir(), '.nvm', 'versions', 'node');
    if (existsSync(nvmNodeDir)) {
      // NB: readdirSync is imported at the top. This file is an ES module, so
      // a local `require('fs')` here throws ReferenceError (require is undefined
      // in ESM) — that exception was silently swallowed by the catch below,
      // disabling the entire nvm scan when the launcher ran under an old Node.
      const candidates = readdirSync(nvmNodeDir)
        .map(name => ({ name, v: parseNodeVersion(name) }))
        .filter(c => c.v && nodeVersionOk(c.v.major, c.v.minor))
        .sort((a, b) => (b.v.major - a.v.major) || (b.v.minor - a.v.minor));
      for (const c of candidates) {
        const candidatePath = join(nvmNodeDir, c.name, 'bin', IS_WINDOWS ? 'node.exe' : 'node');
        if (existsSync(candidatePath)) return candidatePath;
      }
    }
  } catch {
    /* fall through */
  }

  // 3. Well-known install locations + PATH lookup.
  const knownPaths = IS_WINDOWS
    ? ['C:/Program Files/nodejs/node.exe']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const nodePath of knownPaths) {
    if (existsSync(nodePath)) {
      const v = probeNodeVersion(nodePath);
      if (v && nodeVersionOk(v.major, v.minor)) return nodePath;
    }
  }

  const pathCheck = IS_WINDOWS
    ? spawnSync('where node', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: true })
    : spawnSync('which', ['node'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    const found = pathCheck.stdout.split('\n').map(l => l.trim()).find(Boolean);
    if (found) {
      const v = probeNodeVersion(found);
      if (v && nodeVersionOk(v.major, v.minor)) return found;
    }
  }

  return null;
}

function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // No optional chaining (?.) here: this launcher must parse on the oldest
    // Node that any host might invoke it with. Some Claude Code installs run
    // hooks under a bundled pre-ES2020 Node whose ESM loader throws
    // "SyntaxError: Unexpected token '.'" on `?.` (issue #2791).
    return Boolean(
      settings &&
      settings.enabledPlugins &&
      settings.enabledPlugins['light-mem@light-mem'] === false
    );
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node node-runner.js <script> [args...]');
  process.exit(1);
}

args[0] = fixBrokenScriptPath(args[0]);

const nodePath = findModernNode();

if (!nodePath) {
  console.error(`Error: Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ not found. light-mem's worker requires the built-in node:sqlite module (Node ≥ 22.5; Node 24 recommended).`);
  console.error('Install a current Node (e.g. `nvm install 24`) and restart your terminal.');
  process.exit(1);
}

function collectStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      resolve(null);
    });

    setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, 5000);
  });
}

const stdinData = await collectStdin();

const spawnOptions = {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
};

let spawnCmd = nodePath;
let spawnArgs = args;

if (IS_WINDOWS) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  spawnOptions.shell = true;
  spawnCmd = [nodePath, ...args].map(quote).join(' ');
  spawnArgs = [];
}

const child = spawn(spawnCmd, spawnArgs, spawnOptions);

if (child.stdin) {
  if (stdinData && stdinData.length > 0) {
    child.stdin.write(stdinData);
    child.stdin.end();
  } else {
    // Lifecycle subcommands (start, stop, restart, status) never consume stdin —
    // they manage the worker daemon, not hook payloads.  Killing the child here
    // prevents the daemon from starting/stopping on platforms where Claude Code
    // doesn't pipe a payload for SessionStart (e.g. Windows CC ≤ 2.1.145).
    const lifecycleCommands = ['start', 'stop', 'restart', 'status'];
    const isLifecycle = lifecycleCommands.some(cmd => args.includes(cmd));

    if (isLifecycle) {
      // Lifecycle commands don't need stdin — close pipe and let child run.
      try { child.stdin.end(); } catch {}
    } else {
      // Issue #2188: empty/missing stdin previously masked by `|| '{}'` fallback,
      // which silently hid WSL bash failures (e.g. hooks invoked under a broken
      // shell that never piped a payload). Surface the failure mode instead.
      const dataDir = process.env.LIGHT_MEM_DATA_DIR || join(homedir(), '.light-mem');
      const payloadType = stdinData === null
        ? 'null (no data event or stream error)'
        : stdinData === undefined
          ? 'undefined'
          : Buffer.isBuffer(stdinData) && stdinData.length === 0
            ? 'empty Buffer (zero bytes received)'
            : `unexpected (${typeof stdinData})`;
      const payloadByteLength = (stdinData && typeof stdinData.length === 'number')
        ? stdinData.length
        : 0;
      const diagnostic = [
        `[node-runner] empty stdin payload received — issue #2188`,
        `  script: ${args[0]}`,
        `  payload byte length: ${payloadByteLength}`,
        `  payload type: ${payloadType}`,
        `  platform: ${process.platform}`,
        `  shell: ${process.env.SHELL || 'n/a'}`,
        `  stdin TTY: ${process.stdin.isTTY === true ? 'true' : process.stdin.isTTY === false ? 'false' : 'undefined'}`,
        `  timestamp: ${new Date().toISOString()}`,
        `  CLAUDE_PLUGIN_ROOT: ${RESOLVED_PLUGIN_ROOT}`,
      ].join('\n');

      // IO discipline (see src/shared/hook-io.ts intent vocabulary):
      // - this stderr write is a USER_HINT (Claude Code surfaces it inline).
      // - the CAPTURE_BROKEN marker file below is a DIAGNOSTIC durable signal for
      //   the next session-start hint.
      // - exit 0 below is the EXIT_SIGNAL per CLAUDE.md (Windows Terminal tab
      //   management); the marker file, not the exit code, is the durable failure
      //   signal. node-runner runs in its own node process BEFORE hookCommand's
      //   stderr buffer is installed, so this write is never swallowed.

      // Write to stderr so Claude Code surfaces the diagnostic.
      console.error(diagnostic);

      // Persist diagnostic to the runner-errors log and drop a CAPTURE_BROKEN marker
      // file so the next session-start hint can surface the failure. We exit 0 to
      // honor the project's exit-code strategy (worker/hook errors exit 0 to
      // prevent Windows Terminal tab pileup) — the marker file is the durable
      // signal that something is wrong, not the exit code.
      try {
        const logsDir = join(dataDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        appendFileSync(join(logsDir, 'runner-errors.log'), diagnostic + '\n\n');
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'CAPTURE_BROKEN'), diagnostic + '\n');
      } catch (writeErr) {
        console.error(`[node-runner] failed to persist diagnostic: ${writeErr && writeErr.message ? writeErr.message : writeErr}`);
      }

      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      process.exit(0);
    }
  }
}

child.on('error', (err) => {
  // EXCEPTION to CLAUDE.md exit-0-on-error: Node-not-found is a user environment
  // problem, not a hook execution failure. Surfacing exit 1 here forces Claude
  // Code to display the stderr message rather than silently retrying. This runs
  // before any hook handler, so the exit-0 tab-management rationale doesn't apply.
  console.error(`Failed to start Node worker: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if ((signal || code > 128) && args.includes('start')) {
    process.exit(0);
  }
  process.exit(code || 0);
});
