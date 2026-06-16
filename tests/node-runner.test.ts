import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const NODE_RUNNER_PATH = join(import.meta.dirname, '..', 'plugin', 'scripts', 'node-runner.js');
const source = readFileSync(NODE_RUNNER_PATH, 'utf-8');

describe('node-runner.js findModernNode: DEP0190 regression guard (#1503)', () => {
  // node-runner locates a Node ≥22.5 (for node:sqlite), but
  // the DEP0190-safe spawn pattern must be preserved: a single string command
  // with shell:true on Windows, and an args-array WITHOUT shell on Unix.
  it('does not use separate args array with shell:true (DEP0190 trigger pattern)', () => {
    const vulnerablePattern = /spawnSync\s*\(\s*(?:IS_WINDOWS\s*\?\s*['"]where['"]\s*:[^)]+|['"]where['"]),\s*\[[^\]]+\],\s*\{[^}]*shell\s*:\s*(?:true|IS_WINDOWS)/;
    expect(vulnerablePattern.test(source)).toBe(false);
  });

  it('uses a single string command for Windows where-node lookup', () => {
    expect(source).toContain("spawnSync('where node'");
  });

  it('uses no shell option for Unix which-node lookup', () => {
    const unixCallMatch = source.match(/spawnSync\('which',\s*\['node'\],\s*\{([^}]+)\}/)
    if (unixCallMatch) {
      expect(unixCallMatch[1]).not.toContain('shell');
    }
    expect(source).toContain("spawnSync('which', ['node']");
  });
});

describe('node-runner.js findModernNode: ESM require regression guard', () => {
  // The launcher is an ES module (top-level import + import.meta.url). A bare
  // require(...) throws ReferenceError in ESM, and findModernNode wraps the nvm
  // scan in a try/catch that swallows it — so a stray require() silently
  // disables the entire "find a newer Node" path when the launcher runs under
  // an old default Node. That shipped once and broke every hook for users whose
  // nvm default was Node 20. Forbid bare require() in this file.
  it('contains no bare require() calls (would throw in ESM and be swallowed)', () => {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(/\brequire\s*\(/.test(code)).toBe(false);
  });
});

// Functional reproduction: drive the real launcher under an OLD nvm Node and
// assert it re-resolves a Node >= 22.5 instead of erroring. Skips when no
// old-enough Node is installed (e.g. minimal CI with a single current Node).
const OLD_NODE = (() => {
  const dir = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const m = /^v(\d+)\.(\d+)\./.exec(name);
    if (!m) continue;
    const major = Number(m[1]), minor = Number(m[2]);
    const tooOld = major < 22 || (major === 22 && minor < 5);
    if (tooOld) {
      const bin = join(dir, name, 'bin', 'node');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
})();

describe.skipIf(!OLD_NODE)('node-runner.js findModernNode: re-spawns under a newer Node', () => {
  it('locates a Node >= 22.5 when launched by an old Node (does not error out)', () => {
    // `status` is a lifecycle command that prints worker state and exits; if the
    // launcher had failed to find a modern Node it would print the "Node.js
    // 22.5+ not found" error instead. We only assert that error is absent.
    const res = spawnSync(OLD_NODE!, [NODE_RUNNER_PATH, '--version-probe-only'], {
      encoding: 'utf-8',
      timeout: 20_000,
      input: '',
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(out).not.toContain('22.5+ not found');
  });
});
