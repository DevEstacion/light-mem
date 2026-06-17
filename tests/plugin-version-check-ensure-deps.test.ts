import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const VERSION_CHECK_PATH = join(REPO_ROOT, 'plugin', 'scripts', 'version-check.js');
const SPAWN_TIMEOUT_MS = 15_000;
const INSTALL_DIAGNOSTIC = '[version-check] installing plugin dependencies';
const INSTALL_SUCCESS_DIAGNOSTIC = '[version-check] plugin dependencies installed successfully';
const INSTALL_FAILURE_DIAGNOSTIC = '[version-check] npm install failed';
const FAKE_INSTALLED_MARKER_REL = join('node_modules', 'zod', 'v3', 'index.js');
const SKIP_NON_UNIX = process.platform === 'win32';

let tmpRoot: string;

function runVersionCheck(
  pluginRoot: string,
  fakeBinDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stderr: string; stdout: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [VERSION_CHECK_PATH], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        LIGHT_MEM_DATA_DIR: join(pluginRoot, '.light-mem'),
        CLAUDE_CONFIG_DIR: join(pluginRoot, '.claude'),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`version-check subprocess exceeded ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolveResult({ stderr, stdout, code });
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    }
  });
}

type BunBehavior = 'success' | 'partial-then-fail';

function makeFreshPlugin(name: string, bunBehavior: BunBehavior = 'success'): { pluginRoot: string; fakeBinDir: string } {
  const pluginRoot = join(tmpRoot, name);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'fake-plugin',
    version: '0.0.0',
    dependencies: { zod: '^3.0.0' },
  }));
  writeFileSync(join(pluginRoot, '.install-version'), JSON.stringify({ version: '0.0.0' }));

  const fakeBinDir = join(pluginRoot, '.bin');
  mkdirSync(fakeBinDir, { recursive: true });

  // Fake bun behaviors:
  //   - success: creates the install marker file and exits 0 (happy path).
  //   - partial-then-fail: creates the partial node_modules dir THEN exits
  //     non-zero. Mirrors real bun's behavior under network timeout / OOM /
  //     registry 5xx where node_modules already exists when the failure
  //     surfaces. Required to cover the gh #2650 review-fix path that
  //     cleans up the partial dir so the next Setup run can retry.
  // version-check now installs plugin deps with npm (ships with Node), so the
  // fake binary is `npm`. The behavior contract is identical.
  const fakeNpmPath = join(fakeBinDir, 'npm');
  const installBody = bunBehavior === 'success'
    ? [
        `  mkdir -p "${pluginRoot}/node_modules/zod/v3"`,
        `  : > "${pluginRoot}/node_modules/zod/v3/index.js"`,
        '  exit 0',
      ]
    : [
        `  mkdir -p "${pluginRoot}/node_modules"`,
        '  echo "fake npm install failure mid-fetch" 1>&2',
        '  exit 42',
      ];
  const fakeNpmScript = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "install" ]; then',
    // Capture CXXFLAGS so tests can assert the C++20 build flag is passed
    // through to the native-addon compile under Node ≥ 24.
    `  printf '%s' "$CXXFLAGS" > "${pluginRoot}/.cxxflags-seen"`,
    ...installBody,
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(fakeNpmPath, fakeNpmScript);
  chmodSync(fakeNpmPath, 0o755);

  return { pluginRoot, fakeBinDir };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'version-check-deps-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe.skipIf(SKIP_NON_UNIX)('version-check Setup-phase ensurePluginDependencies (gh #2649)', () => {
  test('installs plugin dependencies when node_modules is missing on fresh extract', async () => {
    // This is the gh #2640 / #2637 scenario: marketplace extracts files but
    // never runs `bun install`. Setup MUST detect the missing node_modules and
    // invoke dependency installation, otherwise the next hook (SessionStart
    // worker spawn) crashes with `Cannot find module 'zod/v3'`.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-fresh');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
  });

  test('passes CXXFLAGS=-std=c++20 to npm so native addons build under Node >= 24', async () => {
    // Node >= 24's bundled headers (cppgc/macros.h, v8config.h) require C++20.
    // node-gyp defaults native-addon compiles to C++17, so tree-sitter's
    // binding.cc fails with "C++20 or later required." version-check must
    // export CXXFLAGS=-std=c++20 for the install (gh tree-sitter Node-24 build).
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-cxxflags');

    const { code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    const seen = readFileSync(join(pluginRoot, '.cxxflags-seen'), 'utf-8');
    expect(seen).toContain('-std=c++20');
  });

  test('appends -std=c++20 to a user-provided CXXFLAGS rather than clobbering it', async () => {
    // A user may already export CXXFLAGS (e.g. for a custom toolchain). We must
    // preserve theirs and append ours so the last -std wins where it matters.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-cxxflags-append');

    const { code } = await runVersionCheck(pluginRoot, fakeBinDir, { CXXFLAGS: '-O2 -DNDEBUG' });

    expect(code).toBe(0);
    const seen = readFileSync(join(pluginRoot, '.cxxflags-seen'), 'utf-8');
    expect(seen).toContain('-O2 -DNDEBUG');
    expect(seen).toContain('-std=c++20');
    // Ours must come after the user's so it takes precedence.
    expect(seen.indexOf('-std=c++20')).toBeGreaterThan(seen.indexOf('-O2'));
  });

  test('cleans up partial node_modules after a failed install so next Setup can retry (gh #2650 review)', async () => {
    // Reproduces the Greptile review concern: `bun install` often creates
    // the node_modules directory BEFORE it fails (mid-fetch network
    // timeout, registry 5xx, OOM kill). Without explicit cleanup, the
    // `existsSync(node_modules)` guard would permanently short-circuit
    // every subsequent Setup run and the user has no recovery path short
    // of a manual `rm -rf node_modules`. Verify that after a failed
    // install the partial dir is removed.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-partial-fail', 'partial-then-fail');

    // Sanity-check the failure path: node_modules MUST exist before our
    // cleanup runs (otherwise we are not exercising the gh #2650 scenario).
    // Run version-check once and confirm both the failure diagnostic and
    // the post-cleanup absence of node_modules.
    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_FAILURE_DIAGNOSTIC);
    expect(stderr).toContain('exit 42');
    expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(false);
  });

  test('skips install when node_modules is already present', async () => {
    // Setup runs on every Claude Code launch. If node_modules already exists,
    // the install MUST be skipped — otherwise we re-run a 100 MB+ install on
    // every cold start and burn the user's bandwidth.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-already-installed');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    // The fake bun would have created zod/v3/index.js if invoked — its
    // absence proves the install path was not taken.
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(false);
  });
});

const TS_CLI_INSTALL_DIAGNOSTIC = '[version-check] fetching tree-sitter CLI binary';
const TS_CLI_SUCCESS_DIAGNOSTIC = '[version-check] tree-sitter CLI binary installed successfully';
const TS_CLI_FAILURE_DIAGNOSTIC = '[version-check] tree-sitter CLI binary fetch failed';
const TS_BINARY_NAME = process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';

// Seed a fake tree-sitter-cli package whose install.js either produces the
// binary (success) or exits non-zero (failure). Mirrors how the real package's
// install.js downloads the GitHub binary, without any network.
function seedTreeSitterCli(pluginRoot: string, behavior: 'success' | 'fail'): string {
  const cliDir = join(pluginRoot, 'node_modules', 'tree-sitter-cli');
  mkdirSync(cliDir, { recursive: true });
  const body = behavior === 'success'
    // Write the binary file the way the real install.js would, then exit 0.
    ? `require("fs").writeFileSync(require("path").join(__dirname, ${JSON.stringify(TS_BINARY_NAME)}), "#binary#"); process.exit(0);`
    // Simulate a failed GitHub fetch.
    : `console.error("simulated download failure"); process.exit(7);`;
  writeFileSync(join(cliDir, 'install.js'), body);
  return cliDir;
}

describe.skipIf(SKIP_NON_UNIX)('version-check tree-sitter CLI binary backfill (marketplace path)', () => {
  test('fetches the binary when node_modules exists but the binary is missing', async () => {
    // THE marketplace scenario (this PR): the host populated node_modules
    // (zod present) so the bulk-install guard short-circuits — but the
    // tree-sitter CLI binary was never fetched. The backfill MUST run anyway,
    // independent of that guard, or smart-explore stays broken.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('ts-cli-backfill');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true }); // triggers bulk-install skip
    const cliDir = seedTreeSitterCli(pluginRoot, 'success');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    // Bulk install was skipped (node_modules present)...
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    // ...but the binary backfill still ran and succeeded.
    expect(stderr).toContain(TS_CLI_INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(TS_CLI_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(cliDir, TS_BINARY_NAME))).toBe(true);
  });

  test('is a no-op when the binary is already present (idempotent)', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('ts-cli-present');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    const cliDir = seedTreeSitterCli(pluginRoot, 'success');
    // Pre-place the binary; install.js must NOT run (it would overwrite with "#binary#").
    writeFileSync(join(cliDir, TS_BINARY_NAME), 'PREEXISTING');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(TS_CLI_INSTALL_DIAGNOSTIC);
    expect(readFileSync(join(cliDir, TS_BINARY_NAME), 'utf-8')).toBe('PREEXISTING');
  });

  test('is a no-op when tree-sitter-cli is not installed (no install.js)', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('ts-cli-absent');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    // No tree-sitter-cli dir at all.

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(TS_CLI_INSTALL_DIAGNOSTIC);
  });

  test('degrades gracefully (non-fatal) when the binary fetch fails', async () => {
    // smart-explore is optional; the worker does not depend on this binary, so
    // a failed fetch must log and continue — Setup still exits 0.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('ts-cli-fail');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    const cliDir = seedTreeSitterCli(pluginRoot, 'fail');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0); // NON-FATAL — Setup still succeeds
    expect(stderr).toContain(TS_CLI_INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(TS_CLI_FAILURE_DIAGNOSTIC);
    expect(existsSync(join(cliDir, TS_BINARY_NAME))).toBe(false);
  });
});
