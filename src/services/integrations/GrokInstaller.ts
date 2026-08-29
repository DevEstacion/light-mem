import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

const GROK_HOOKS_TEMPLATE = 'grok-hooks.json';
// Grok reads every *.json in ~/.grok/hooks (xai-org/grok-build discovery.rs).
// light-mem owns exactly this one file, so install/uninstall just write/remove
// it wholesale — no merge with user hooks needed.
const GROK_HOOKS_INSTALLED_FILENAME = 'light-mem.json';

export function getGrokHooksDirectory(): string {
  return path.join(homedir(), '.grok', 'hooks');
}

export function getGrokHooksPath(): string {
  return path.join(getGrokHooksDirectory(), GROK_HOOKS_INSTALLED_FILENAME);
}

export function findBuiltGrokHooksPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'hooks', GROK_HOOKS_TEMPLATE),
    path.join(process.cwd(), 'plugin', 'hooks', GROK_HOOKS_TEMPLATE),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Install light-mem's per-tool observation hook into ~/.grok/hooks/light-mem.json.
 *
 * Grok Build reads the shared Claude plugin hooks.json for every other lifecycle
 * hook, but that file now uses PostToolBatch (which Grok has no event for and
 * silently skips). This dedicated file restores Grok's PostToolUse observation
 * capture. Returns 0 on success, 1 on failure.
 */
export function installGrokIntegration(): number {
  const sourcePath = findBuiltGrokHooksPath();
  if (!sourcePath) {
    console.error(
      'light-mem Grok hooks not found. Run `npm run build` (expected plugin/hooks/grok-hooks.json).',
    );
    return 1;
  }

  const dir = getGrokHooksDirectory();
  const hooksPath = getGrokHooksPath();

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create ${dir}: ${message}`);
    return 1;
  }

  try {
    // Copy through a parse so a corrupt template fails loudly here, not at
    // Grok load time.
    const contents = readFileSync(sourcePath, 'utf-8');
    JSON.parse(contents);
    writeFileSync(hooksPath, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write ${hooksPath}: ${message}`);
    return 1;
  }

  console.log(`  Grok hooks installed → ${hooksPath}`);
  console.log('  Trust the folder + run /hooks in Grok to reload.');
  logger.info('SYSTEM', 'Grok hooks installed', { hooksPath, sourcePath });
  return 0;
}

/**
 * Remove ~/.grok/hooks/light-mem.json. Returns 0 (idempotent — missing file is
 * a no-op success).
 */
export function uninstallGrokIntegration(): number {
  const hooksPath = getGrokHooksPath();
  if (!existsSync(hooksPath)) {
    console.log('  No ~/.grok/hooks/light-mem.json found — nothing to uninstall.');
    return 0;
  }
  try {
    rmSync(hooksPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to remove ${hooksPath}: ${message}`);
    return 1;
  }
  console.log(`  Grok light-mem hooks removed from ${hooksPath}`);
  return 0;
}
