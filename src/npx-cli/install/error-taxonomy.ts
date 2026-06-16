/**
 * Installer error taxonomy — the single source of truth for classifying every
 * failure the universal installer (`npx light-mem install`) can hit, and the
 * remediation we surface for each.
 *
 * Design constraints (see plans/04-installer-transparency.md):
 *  - Fail loud over silent. Unknown errors default to ABORT until classified.
 *  - Remediation strings interpolate the resolved data dir (multi-account safe),
 *    never a hard-coded ~/.light-mem path.
 *  - There is NO `SILENT` severity — the closest is SILENT_RETRY (retry once,
 *    then escalate to a visible WARN_CONTINUE).
 */

export enum ErrorSeverity {
  /** exit 1, do not continue. */
  ABORT = 'ABORT',
  /** exit 1 only if all IDEs fail; otherwise partial summary, continue. */
  FAIL_LOUD_PER_IDE = 'FAIL_LOUD_PER_IDE',
  /** print warning to end-of-install summary, continue (exit 0). */
  WARN_CONTINUE = 'WARN_CONTINUE',
  /** retry once with backoff; escalate to WARN_CONTINUE on repeated failure. */
  SILENT_RETRY = 'SILENT_RETRY',
}

export interface RemediationContext {
  platform: NodeJS.Platform;
  /** Resolved data dir (honors LIGHT_MEM_DATA_DIR). */
  dataDir: string;
}

export interface MatchContext {
  component: string;
  phase: string;
}

export interface ErrorCategory {
  id: string;
  severity: ErrorSeverity;
  match: (cause: unknown, ctx: MatchContext) => boolean;
  remediation: (ctx: RemediationContext) => string;
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause ?? '');
}

const NODE_REMEDIATION = (ctx: RemediationContext): string =>
  ctx.platform === 'win32'
    ? 'Install Node.js ≥24 then re-run `npx light-mem install`. Windows: `winget install OpenJS.NodeJS` (or via nvm-windows).'
    : 'Install Node.js ≥24 then re-run `npx light-mem install`. macOS/Linux: `nvm install 24` (or `brew install node`).';

/**
 * The canonical category list. Ordered most-specific-first; `classifyError`
 * returns the first matching category. The trailing `unknown-install-error`
 * default is ABORT — an unclassified failure is a fail-loud failure.
 */
export const ERROR_CATEGORIES: ErrorCategory[] = [
  {
    id: 'node-runtime-too-old',
    severity: ErrorSeverity.ABORT,
    match: (cause) => {
      const m = causeMessage(cause);
      return (
        m.includes('Node.js') && m.includes('is required') ||
        m.includes('node:sqlite')
      );
    },
    remediation: NODE_REMEDIATION,
  },
  {
    id: 'tree-sitter-eresolve',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /\bERESOLVE\b/.test(causeMessage(cause)),
    remediation: () =>
      'ERESOLVE peer-dependency conflict in marketplace deps that --legacy-peer-deps could not resolve. Open an issue at https://github.com/Ronald-Estacion_NordTech/light-mem/issues with the conflicting peer ranges shown above.',
  },
  {
    id: 'npm-install-network-fail',
    severity: ErrorSeverity.SILENT_RETRY,
    match: (cause) => /error: failed to resolve|ETIMEDOUT|ENOTFOUND|ECONNRESET/.test(causeMessage(cause)),
    remediation: () =>
      'npm install failed to resolve packages — check network connectivity and re-run `npx light-mem install`. Cached packages in npm\'s cache will be reused.',
  },
  {
    id: 'marketplace-dir-not-writable',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /\b(EACCES|EPERM)\b/.test(causeMessage(cause)),
    remediation: (ctx) =>
      `Cannot write to the light-mem data/marketplace directory under ${ctx.dataDir}. Check filesystem permissions or set LIGHT_MEM_DATA_DIR to a writable path, then re-run.`,
  },
  {
    id: 'plugin-json-corrupt',
    severity: ErrorSeverity.ABORT,
    match: (cause, ctx) =>
      ctx.component === 'plugin-json' &&
      /Unexpected token|JSON|parse/i.test(causeMessage(cause)),
    remediation: () =>
      'Existing plugin.json is corrupt. Run `rm -rf ~/.claude/plugins/marketplaces/light-mem` and re-run `npx light-mem install`.',
  },
  {
    id: 'all-ides-failed',
    severity: ErrorSeverity.ABORT,
    match: (_cause, ctx) => ctx.component === 'all-ides',
    remediation: () =>
      'Every selected IDE integration failed. See the per-IDE errors above. Re-run with `--ide=<single>` to isolate the failure.',
  },
  {
    id: 'single-ide-failed',
    severity: ErrorSeverity.FAIL_LOUD_PER_IDE,
    match: (_cause, ctx) => ctx.phase === 'ide-install',
    remediation: () =>
      'Re-run `npx light-mem install --ide=<name>` to retry just this IDE. The captured stderr is shown above.',
  },
  {
    id: 'path-update-failed',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component === 'path-update',
    remediation: () =>
      'Could not auto-update PATH in your shell config. Add the printed export line manually and restart your shell.',
  },
  {
    id: 'auto-memory-toggle-failed',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component === 'auto-memory',
    remediation: () =>
      'Could not disable Claude Code auto-memory. Add `"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"` to the env block in ~/.claude/settings.json.',
  },
  {
    id: 'version-probe-transient',
    severity: ErrorSeverity.WARN_CONTINUE,
    match: (_cause, ctx) => ctx.component.endsWith('-version-probe'),
    remediation: () =>
      'Could not verify the tool version after install — the installation is likely OK. Re-run `npx light-mem install` if features misbehave.',
  },
  {
    id: 'child-process-timeout',
    severity: ErrorSeverity.ABORT,
    match: (cause) => /timed out|ETIMEDOUT|SIGTERM|did not finish/i.test(causeMessage(cause)),
    remediation: () =>
      'An install command did not finish in time. Check network connectivity. On a slow host, raise the budget with LIGHT_MEM_INSTALL_TIMEOUT_MS and re-run.',
  },
  {
    id: 'unknown-install-error',
    severity: ErrorSeverity.ABORT,
    match: () => true,
    remediation: (ctx) =>
      `An unexpected installer error occurred. Capture ${ctx.dataDir}/last-install-error.json and open an issue at https://github.com/Ronald-Estacion_NordTech/light-mem/issues.`,
  },
];

/**
 * Classify a raw error against the taxonomy. Always returns a category — the
 * fail-loud default (`unknown-install-error`, ABORT) is last in the list.
 */
export function classifyError(cause: unknown, ctx: MatchContext): ErrorCategory {
  for (const category of ERROR_CATEGORIES) {
    if (category.match(cause, ctx)) return category;
  }
  // Unreachable — the default category matches everything — but TypeScript and
  // fail-loud hygiene both want an explicit fallback.
  return ERROR_CATEGORIES[ERROR_CATEGORIES.length - 1];
}
