import path from 'path';
import { homedir } from 'os';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

const CODEX_HOOKS_FILENAME = 'codex-hooks.json';

type CodexHookHandler = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
};

type CodexHookGroup = {
  matcher?: string;
  hooks?: CodexHookHandler[];
  [key: string]: unknown;
};

type CodexHooksFile = {
  description?: string;
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
};

export function getCodexConfigDirectory(): string {
  return path.join(homedir(), '.codex');
}

export function getCodexHooksPath(): string {
  return path.join(getCodexConfigDirectory(), 'hooks.json');
}

export function findBuiltCodexHooksPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'hooks', CODEX_HOOKS_FILENAME),
    path.join(process.cwd(), 'plugin', 'hooks', CODEX_HOOKS_FILENAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isLightMemHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes('worker-service.cjs');
}

function isLightMemHookGroup(group: CodexHookGroup): boolean {
  return (group.hooks ?? []).some((handler) => isLightMemHookCommand(handler.command));
}

/**
 * Merge light-mem's Codex hook groups into an existing ~/.codex/hooks.json,
 * replacing any previous light-mem groups (identified by worker-service.cjs
 * in the command) while preserving the user's other hooks.
 *
 * Codex discovers hooks from ~/.codex/hooks.json (and config.toml);
 * see https://learn.chatgpt.com/docs/hooks
 */
export function mergeCodexHooks(
  existing: CodexHooksFile | null,
  lightMem: CodexHooksFile,
): CodexHooksFile {
  const result: CodexHooksFile = {
    ...(existing ?? {}),
    hooks: { ...(existing?.hooks ?? {}) },
  };

  if (!result.description && lightMem.description) {
    result.description = lightMem.description;
  }

  for (const [event, groups] of Object.entries(lightMem.hooks ?? {})) {
    const prior = (result.hooks![event] ?? []).filter((group) => !isLightMemHookGroup(group));
    result.hooks![event] = [...prior, ...groups];
  }

  return result;
}

function readJsonSafe(filePath: string): CodexHooksFile | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as CodexHooksFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`);
  }
}

/**
 * Install light-mem lifecycle hooks into ~/.codex/hooks.json.
 * Returns 0 on success, 1 on failure.
 */
export function installCodexIntegration(): number {
  const sourcePath = findBuiltCodexHooksPath();
  if (!sourcePath) {
    console.error(
      'light-mem Codex hooks not found. Run `npm run build` (expected plugin/hooks/codex-hooks.json).',
    );
    return 1;
  }

  let lightMemHooks: CodexHooksFile;
  try {
    lightMemHooks = JSON.parse(readFileSync(sourcePath, 'utf-8')) as CodexHooksFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read Codex hooks template: ${message}`);
    return 1;
  }

  const codexDir = getCodexConfigDirectory();
  const hooksPath = getCodexHooksPath();

  try {
    mkdirSync(codexDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create ${codexDir}: ${message}`);
    return 1;
  }

  // Keep a pristine copy for uninstall / reinstall diagnostics.
  try {
    copyFileSync(sourcePath, path.join(codexDir, 'light-mem-hooks.json'));
  } catch (error) {
    logger.debug(
      'CODEX',
      'Could not write light-mem-hooks.json snapshot',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  let existing: CodexHooksFile | null = null;
  try {
    existing = readJsonSafe(hooksPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }

  const merged = mergeCodexHooks(existing, lightMemHooks);

  try {
    if (existsSync(hooksPath)) {
      const backupPath = `${hooksPath}.bak-light-mem`;
      copyFileSync(hooksPath, backupPath);
    }
    writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write ${hooksPath}: ${message}`);
    return 1;
  }

  console.log(`  Codex hooks installed → ${hooksPath}`);
  console.log('  Trust them in Codex with `/hooks` (non-managed hooks require review).');
  logger.info('CODEX', 'Codex hooks installed', { hooksPath, sourcePath });
  return 0;
}

/**
 * Remove light-mem hook groups from ~/.codex/hooks.json.
 */
export function uninstallCodexIntegration(): number {
  const hooksPath = getCodexHooksPath();
  if (!existsSync(hooksPath)) {
    console.log('  No ~/.codex/hooks.json found — nothing to uninstall.');
    return 0;
  }

  let existing: CodexHooksFile;
  try {
    existing = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CodexHooksFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse ${hooksPath}: ${message}`);
    return 1;
  }

  const cleaned: CodexHooksFile = { ...existing, hooks: {} };
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const remaining = groups.filter((group) => !isLightMemHookGroup(group));
    if (remaining.length > 0) {
      cleaned.hooks![event] = remaining;
    }
  }

  const hasAny = Object.keys(cleaned.hooks ?? {}).length > 0;
  try {
    if (hasAny) {
      writeFileSync(hooksPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf-8');
    } else {
      // Leave an empty hooks object rather than deleting user-owned file.
      writeFileSync(hooksPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`, 'utf-8');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write ${hooksPath}: ${message}`);
    return 1;
  }

  const snapshot = path.join(getCodexConfigDirectory(), 'light-mem-hooks.json');
  try {
    if (existsSync(snapshot)) {
      // best-effort cleanup
      writeFileSync(snapshot, '');
    }
  } catch {
    // ignore
  }

  console.log(`  Codex light-mem hooks removed from ${hooksPath}`);
  return 0;
}
