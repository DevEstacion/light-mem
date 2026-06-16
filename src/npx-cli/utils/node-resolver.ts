import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from './paths.js';

// The worker needs Node ≥ 24 (built-in node:sqlite, unflagged). The `npx`
// process running this CLI may itself be an older Node, so resolve a
// new-enough Node to spawn the worker with — mirroring plugin/scripts/node-runner.js.
const MIN_NODE_MAJOR = 24;

function parseMajor(version: string): number {
  const m = /v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

function probeMajor(nodePath: string): number {
  try {
    const r = spawnSync(nodePath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? parseMajor(r.stdout) : 0;
  } catch {
    return 0;
  }
}

/** Resolve a Node ≥24 binary path (or null if none found). */
export function resolveNodeBinaryPath(): string | null {
  // 1. The Node running this CLI, if new enough.
  if (parseMajor(process.version) >= MIN_NODE_MAJOR) {
    return process.execPath;
  }

  // 2. Highest nvm-installed Node ≥24.
  try {
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
    if (existsSync(nvmDir)) {
      const candidates = readdirSync(nvmDir)
        .map(name => ({ name, major: parseMajor(name) }))
        .filter(c => c.major >= MIN_NODE_MAJOR)
        .sort((a, b) => b.major - a.major);
      for (const c of candidates) {
        const p = join(nvmDir, c.name, 'bin', IS_WINDOWS ? 'node.exe' : 'node');
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* fall through */
  }

  // 3. Known install locations + PATH lookup.
  const known = IS_WINDOWS
    ? ['C:/Program Files/nodejs/node.exe']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const p of known) {
    if (existsSync(p) && probeMajor(p) >= MIN_NODE_MAJOR) return p;
  }

  const whichCommand = IS_WINDOWS ? 'where' : 'which';
  const pathCheck = spawnSync(whichCommand, ['node'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
  });
  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    const found = pathCheck.stdout.split('\n').map(l => l.trim()).find(Boolean);
    if (found && probeMajor(found) >= MIN_NODE_MAJOR) return found;
  }

  return null;
}
