import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  claudeSettingsPath,
  installedPluginsPath,
  isPluginInstalled,
  knownMarketplacesPath,
  marketplaceDirectory,
  pluginsDirectory,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';

function removeMarketplaceDirectory(): boolean {
  const marketplaceDir = marketplaceDirectory();
  if (existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeCacheDirectory(): boolean {
  const cacheDirectory = join(pluginsDirectory(), 'cache', 'light-mem', 'light-mem');
  if (existsSync(cacheDirectory)) {
    rmSync(cacheDirectory, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeFromKnownMarketplaces(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});
  if (knownMarketplaces['light-mem']) {
    delete knownMarketplaces['light-mem'];
    writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
  }
}

function removeFromInstalledPlugins(): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});
  if (installedPlugins.plugins?.['light-mem@light-mem']) {
    delete installedPlugins.plugins['light-mem@light-mem'];
    writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
  }
}

function stripLegacyLightMemAlias(): void {
  const home = homedir();
  const candidateFiles = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];

  const aliasLineRegex = /^\s*alias\s+light-mem\s*=/;

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${filePath}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    const lines = content.split('\n');
    const filtered = lines.filter((line) => !aliasLineRegex.test(line));
    if (filtered.length === lines.length) continue; 
    try {
      writeFileSync(filePath, filtered.join('\n'));
      console.error(`Removed legacy light-mem alias from ${filePath}`);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not rewrite ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export function removeFromClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  let dirty = false;

  if (settings.enabledPlugins?.['light-mem@light-mem'] !== undefined) {
    delete settings.enabledPlugins['light-mem@light-mem'];
    dirty = true;
  }

  // Symmetric counterpart to disableClaudeAutoMemory() in install.ts. The
  // installer sets env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1" to suppress
  // Claude Code's built-in auto-memory; on uninstall we restore the host
  // CLI's default behavior by removing that key. The value-equality guard
  // (=== '1') ensures we only strip the specific token the installer wrote
  // — if a user had pre-set this key to something else (e.g. '0' to force
  // auto-memory on), or to '1' themselves before installing light-mem,
  // their intent is preserved. The installer's own no-op-when-already-'1'
  // path means the worst case is leaving behind a value light-mem would
  // have written anyway. Any other env entries the user added themselves
  // (ANTHROPIC_AUTH_TOKEN, AWS_REGION, etc.) are preserved. If the env
  // block becomes empty as a result, the block itself is dropped to keep
  // settings.json tidy.
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    if (
      Object.prototype.hasOwnProperty.call(settings.env, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') &&
      settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1'
    ) {
      delete settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      dirty = true;
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
    }
  }

  if (dirty) {
    writeJsonFileAtomic(claudeSettingsPath(), settings);
  }
}

function removeStrayLightMemPaths(): number {
  const home = homedir();
  let removedCount = 0;

  const npxRoot = join(home, '.npm', '_npx');
  if (existsSync(npxRoot)) {
    let hashDirs: string[] = [];
    try {
      hashDirs = readdirSync(npxRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${npxRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const hashDir of hashDirs) {
      const candidate = join(npxRoot, hashDir, 'node_modules', 'light-mem');
      if (!existsSync(candidate)) continue;
      try {
        rmSync(candidate, { recursive: true, force: true });
        removedCount++;
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not remove ${candidate}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const cacheRoot = join(home, '.cache', 'claude-cli-nodejs');
  if (existsSync(cacheRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(cacheRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${cacheRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const projectDir of projectDirs) {
      const projectPath = join(cacheRoot, projectDir);
      let logEntries: string[] = [];
      try {
        logEntries = readdirSync(projectPath);
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not read ${projectPath}:`, error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const entry of logEntries) {
        if (!entry.startsWith('mcp-logs-plugin-light-mem-')) continue;
        const logPath = join(projectPath, entry);
        try {
          rmSync(logPath, { recursive: true, force: true });
          removedCount++;
        } catch (error: unknown) {
          console.warn(`[uninstall] Could not remove ${logPath}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const pluginDataDir = join(home, '.claude', 'plugins', 'data', 'light-mem-light-mem');
  if (existsSync(pluginDataDir)) {
    try {
      rmSync(pluginDataDir, { recursive: true, force: true });
      removedCount++;
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not remove ${pluginDataDir}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return removedCount;
}

export async function runUninstallCommand(): Promise<void> {
  p.intro(pc.bgRed(pc.white(' light-mem uninstall ')));

  if (!isPluginInstalled()) {
    p.log.warn('light-mem does not appear to be installed.');

    if (process.stdin.isTTY) {
      const shouldCleanup = await p.confirm({
        message: 'Clean up any remaining registration data anyway?',
        initialValue: false,
      });

      if (p.isCancel(shouldCleanup) || !shouldCleanup) {
        p.outro('Nothing to do.');
        return;
      }
    } else {
      p.outro('Nothing to do.');
      return;
    }
  } else if (process.stdin.isTTY) {
    const shouldContinue = await p.confirm({
      message: 'Are you sure you want to uninstall light-mem?',
      initialValue: false,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel('Uninstall cancelled.');
      return;
    }
  }

  const workerPort = SettingsDefaultsManager.get('LIGHT_MEM_WORKER_PORT');
  try {
    const result = await shutdownWorkerAndWait(workerPort, 10000);
    if (result.workerWasRunning) {
      p.log.info('Worker service stopped.');
    }
  } catch (error: unknown) {
    console.warn('[uninstall] Worker shutdown attempt failed:', error instanceof Error ? error.message : String(error));
  }

  // #2568 — server-runtime teardown. Gated on the installed/selected runtime so
  // the worker uninstall path is completely unchanged. The bundled Docker
  // compose stack lives under the marketplace dir; if it's present we treat the
  // stack as locally managed and instruct teardown (the actual `docker compose
  // down -v` is an operator/CI side effect, not run from this Node process).
  await p.tasks([
    {
      title: 'Removing marketplace directory',
      task: async () => {
        const removed = removeMarketplaceDirectory();
        return removed
          ? `Marketplace directory removed ${pc.green('OK')}`
          : `Marketplace directory not found ${pc.dim('skipped')}`;
      },
    },
    {
      title: 'Removing cache directory',
      task: async () => {
        const removed = removeCacheDirectory();
        return removed
          ? `Cache directory removed ${pc.green('OK')}`
          : `Cache directory not found ${pc.dim('skipped')}`;
      },
    },
    {
      title: 'Removing marketplace registration',
      task: async () => {
        removeFromKnownMarketplaces();
        return `Marketplace registration removed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing plugin registration',
      task: async () => {
        removeFromInstalledPlugins();
        return `Plugin registration removed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing from Claude settings',
      task: async () => {
        removeFromClaudeSettings();
        return `Claude settings updated ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing legacy light-mem shell alias',
      task: async () => {
        stripLegacyLightMemAlias();
        return `Legacy alias check complete ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing OpenCode plugin integration',
      task: async () => {
        try {
          const { uninstallOpenCodePlugin } = await import('../../services/integrations/OpenCodeInstaller.js');
          const result = uninstallOpenCodePlugin();
          return result === 0
            ? `OpenCode integration removed ${pc.green('OK')}`
            : `OpenCode integration removal had errors ${pc.yellow('!')}`;
        } catch {
          return `OpenCode integration not installed ${pc.dim('skipped')}`;
        }
      },
    },
    {
      title: 'Removing stray light-mem caches and logs',
      task: async () => {
        const removed = removeStrayLightMemPaths();
        return removed > 0
          ? `Stray paths removed: ${removed} ${pc.green('OK')}`
          : `No stray paths found ${pc.dim('skipped')}`;
      },
    },
  ]);

  p.note(
    [
      `Your data directory at ${pc.cyan('~/.light-mem')} was preserved.`,
      'To remove it manually: rm -rf ~/.light-mem',
    ].join('\n'),
    'Note',
  );

  p.outro(pc.green('light-mem has been uninstalled.'));
}
