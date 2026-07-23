import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from '../utils/paths.js';

export interface IDEInfo {
  id: string;
  label: string;
  detected: boolean;
  supported: boolean;
  hint?: string;
}

function isCommandInPath(command: string): boolean {
  try {
    const whichCommand = IS_WINDOWS ? 'where' : 'which';
    execSync(`${whichCommand} ${command}`, { stdio: 'pipe' });
    return true;
  } catch (error: unknown) {
    if (process.env.DEBUG) {
      console.error(`[ide-detection] ${command} not in PATH:`, error instanceof Error ? error.message : String(error));
    }
    return false;
  }
}

export function detectInstalledIDEs(): IDEInfo[] {
  const home = homedir();

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      detected: isCommandInPath('claude'),
      supported: true,
      hint: 'recommended',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      detected:
        existsSync(join(home, '.config', 'opencode')) || isCommandInPath('opencode'),
      supported: true,
      hint: 'plugin-based integration (full capture)',
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      detected:
        existsSync(join(home, '.codex')) || isCommandInPath('codex'),
      supported: true,
      hint: 'hooks.json integration (SessionStart / PostToolUse / Stop)',
    },
    {
      id: 'grok',
      label: 'Grok Build',
      detected:
        existsSync(join(home, '.grok')) || isCommandInPath('grok'),
      supported: true,
      hint: 'loads Claude plugin hooks (camelCase stdin handled)',
    },
  ];
}
