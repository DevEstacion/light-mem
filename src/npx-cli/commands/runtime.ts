import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync } from 'fs';
import { join } from 'path';
import pc from 'picocolors';
import { resolveNodeBinaryPath } from '../utils/node-resolver.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

function ensureInstalledOrExit(): void {
  if (!isPluginInstalled()) {
    console.error(pc.red('light-mem is not installed.'));
    console.error(`Run: ${pc.bold('npx light-mem install')}`);
    process.exit(1);
  }
}

function resolveNodeOrExit(): string {
  const nodePath = resolveNodeBinaryPath();
  if (!nodePath) {
    console.error(pc.red('Node.js ≥24 not found.'));
    console.error('Install Node 24+: https://nodejs.org (or `nvm install 24`).');
    console.error('After installation, restart your terminal.');
    process.exit(1);
  }
  return nodePath;
}

function workerServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
}

function spawnNodeWorkerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const nodePath = resolveNodeOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx light-mem install');
    process.exit(1);
  }

  const args = [workerScript, command, ...extraArgs];

  const child = spawnHidden(nodePath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Node worker/transcript process. Credentials are
    // re-read from ~/.light-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start worker: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runStartCommand(): void {
  spawnNodeWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnNodeWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnNodeWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnNodeWorkerCommand('status');
}

export function runAdoptCommand(extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const nodePath = resolveNodeOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx light-mem install');
    process.exit(1);
  }

  const userCwd = process.cwd();
  const args = [workerScript, 'adopt', '--cwd', userCwd, ...extraArgs];

  const child = spawnHidden(nodePath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Node worker/transcript process. Credentials are
    // re-read from ~/.light-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start worker: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runCleanupCommand(extraArgs: string[] = []): void {
  spawnNodeWorkerCommand('cleanup', extraArgs);
}

export async function runSearchCommand(queryParts: string[]): Promise<void> {
  ensureInstalledOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(pc.red('Usage: npx light-mem search <query>'));
    process.exit(1);
  }

  const workerPort = SettingsDefaultsManager.get('LIGHT_MEM_WORKER_PORT');
  const searchUrl = `http://127.0.0.1:${workerPort}/api/search?query=${encodeURIComponent(query)}`;

  let response: Response;
  try {
    response = await fetch(searchUrl);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(pc.red('Worker is not running.'));
      console.error(`Start it with: ${pc.bold('npx light-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    if (response.status === 404) {
      console.error(pc.red('Search endpoint not found. Is the worker running?'));
      console.error(`Try: ${pc.bold('npx light-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: HTTP ${response.status}`));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Search failed: invalid JSON response (${message})`));
    process.exit(1);
  }

  if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

export function runTranscriptWatchCommand(): void {
  ensureInstalledOrExit();
  const nodePath = resolveNodeOrExit();

  const transcriptWatcherPath = join(
    marketplaceDirectory(),
    'plugin',
    'scripts',
    'transcript-watcher.cjs',
  );

  if (!existsSync(transcriptWatcherPath)) {
    spawnNodeWorkerCommand('transcript', ['watch']);
    return;
  }

  const child = spawnHidden(nodePath, [transcriptWatcherPath, 'watch'], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Node worker/transcript process. Credentials are
    // re-read from ~/.light-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start transcript watcher: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}
