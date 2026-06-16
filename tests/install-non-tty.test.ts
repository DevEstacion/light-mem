import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const installSourcePath = join(
  import.meta.dirname,
  '..',
  'src',
  'npx-cli',
  'commands',
  'install.ts',
);
const installSource = readFileSync(installSourcePath, 'utf-8');
const syncMarketplaceSourcePath = join(
  import.meta.dirname,
  '..',
  'scripts',
  'sync-marketplace.cjs',
);
const syncMarketplaceSource = readFileSync(syncMarketplaceSourcePath, 'utf-8');

describe('Install Non-TTY Support', () => {
  describe('isInteractive flag', () => {
    it('defines isInteractive based on process.stdin.isTTY', () => {
      expect(installSource).toContain('const isInteractive = process.stdin.isTTY === true');
    });

    it('uses strict equality (===) not truthy check for isTTY', () => {
      const match = installSource.match(/const isInteractive = process\.stdin\.isTTY === true/);
      expect(match).not.toBeNull();
    });
  });

  describe('runTasks helper', () => {
    it('defines a runTasks function', () => {
      expect(installSource).toContain('async function runTasks');
    });

    it('has interactive branch using p.tasks', () => {
      expect(installSource).toContain('await p.tasks(tasks)');
    });

    it('has non-interactive fallback using console.log', () => {
      expect(installSource).toContain('console.log(`  ${msg}`)');
    });

    it('branches on isInteractive', () => {
      expect(installSource).toContain('if (isInteractive)');
    });
  });

  describe('log wrapper', () => {
    it('defines log.info that falls back to console.log', () => {
      expect(installSource).toContain('info: (msg: string) =>');
      expect(installSource).toMatch(/info:.*console\.log/);
    });

    it('defines log.success that falls back to console.log', () => {
      expect(installSource).toContain('success: (msg: string) =>');
      expect(installSource).toMatch(/success:.*console\.log/);
    });

    it('defines log.warn that falls back to console.warn', () => {
      expect(installSource).toContain('warn: (msg: string) =>');
      expect(installSource).toMatch(/warn:.*console\.warn/);
    });

    it('defines log.error that falls back to console.error', () => {
      expect(installSource).toContain('error: (msg: string) =>');
      expect(installSource).toMatch(/error:.*console\.error/);
    });
  });

  describe('non-interactive install path', () => {
    it('defaults to claude-code when not interactive and no IDE specified', () => {
      expect(installSource).toContain("selectedIDEs = ['claude-code']");
    });

    it('parses the explicit --disable-auto-memory flag for non-interactive installs', () => {
      expect(readFileSync(join(import.meta.dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8'))
        .toContain("disableAutoMemory: argv.includes('--disable-auto-memory')");
    });

    it('documents the explicit --disable-auto-memory install flag in help output', () => {
      expect(readFileSync(join(import.meta.dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8'))
        .toContain('npx light-mem install --disable-auto-memory');
    });

    it('uses console.log for intro in non-interactive mode', () => {
      expect(installSource).toContain("console.log('light-mem install')");
    });

    it('uses console.log for note/summary in non-interactive mode', () => {
      expect(installSource).toContain("console.log(`\\n  ${installStatus}`)");
    });

    it('copies plugin and agents entries to the durable marketplace directory', () => {
      const copyRegion = installSource.slice(
        installSource.indexOf('const allowedTopLevelEntries = ['),
        installSource.indexOf('function copyPluginToCache'),
      );
      expect(copyRegion).toContain("'.agents'");
      // Root .mcp.json was dropped in #2411; the MCP manifest now ships
      // exclusively as plugin/.mcp.json (bundled inside the 'plugin' entry).
      expect(copyRegion).toContain("'plugin'");
      expect(copyRegion).not.toContain("'.mcp.json'");
    });

    it('keeps the sync-managed gitignore override mechanism for local marketplace sync', () => {
      const gitignoreExcludeRegion = syncMarketplaceSource.slice(
        syncMarketplaceSource.indexOf('function getGitignoreExcludes'),
        syncMarketplaceSource.indexOf('const branch = getCurrentBranch'),
      );
      // Root .mcp.json was dropped in #2411, so it is no longer a
      // sync-managed override — the override mechanism itself remains.
      expect(gitignoreExcludeRegion).toContain('syncManagedFiles');
      expect(gitignoreExcludeRegion).toContain('syncManagedFiles.has(line)');
    });

  });

  describe('TaskDescriptor interface', () => {
    it('defines a task interface with title and task function', () => {
      expect(installSource).toContain('interface TaskDescriptor');
      expect(installSource).toContain('title: string');
      expect(installSource).toContain('task: (message: (msg: string) => void) => Promise<string>');
    });
  });

  describe('InstallOptions interface', () => {
    it('exports InstallOptions with optional ide field', () => {
      expect(installSource).toContain('export interface InstallOptions');
      expect(installSource).toContain('ide?: string');
    });
  });

  describe('runtime selection', () => {
    it('installs the worker runtime with no server-beta option', () => {
      expect(installSource).toContain("LIGHT_MEM_RUNTIME: 'worker'");
      expect(installSource).not.toContain('server-beta');
      expect(installSource).not.toContain('Server (beta)');
    });
  });

  describe('post-install Next Steps copy', () => {
    it('frames the choice as two paths', () => {
      expect(installSource).toContain('Two paths from here:');
    });

    it('sets timing honesty about second-session memory injection', () => {
      expect(installSource).toContain('Memory injection starts on your second session in a project.');
    });

    it('addresses privacy: everything stays local', () => {
      expect(installSource).toContain('Everything stays in ');
      expect(installSource).toContain("pc.cyan('~/.light-mem')");
    });

    it('keeps /learn-codebase as the optional front-load path', () => {
      expect(installSource).toContain('/learn-codebase');
    });

    it('demotes the uninstall caveat into a dim footer', () => {
      expect(installSource).toContain('close all Claude Code sessions before uninstalling');
    });

    it('does not advertise /mem-search in the post-install Next Steps', () => {
      const nextStepsRegion = installSource.slice(
        installSource.indexOf('const nextSteps = '),
        installSource.indexOf("p.note(nextSteps.join"),
      );
      expect(nextStepsRegion).not.toContain('/mem-search');
    });

    it('does not advertise /knowledge-agent in the post-install Next Steps', () => {
      const nextStepsRegion = installSource.slice(
        installSource.indexOf('const nextSteps = '),
        installSource.indexOf("p.note(nextSteps.join"),
      );
      expect(nextStepsRegion).not.toContain('/knowledge-agent');
    });
  });
});
