/**
 * platform-installers.ts — per-platform install strategies.
 *
 * light-mem supports exactly four platforms: Claude Code, Grok Build, Codex
 * CLI, and OpenCode. They converge on almost everything (runtime tagging,
 * hook-envelope normalization, plugin-root resolution) and diverge on ONE
 * axis: the install artifact.
 *
 *   - claude-code → registers the marketplace plugin (handled by the CLI's
 *     marketplace step; the per-IDE task is a pure confirmation message).
 *   - grok        → no artifact of its own; it loads the Claude plugin hooks
 *     (camelCase stdin is handled by the shared adapter). Pure message.
 *   - codex       → merges hooks into ~/.codex/hooks.json (CodexInstaller).
 *   - opencode    → installs a JS plugin bundle + AGENTS.md (OpenCodeInstaller).
 *
 * Each platform is modeled as a small strategy so the install dispatcher is a
 * registry lookup instead of a switch. The CLI (install.ts) owns presentation
 * (spinner, console buffering, failure routing); a strategy owns only WHAT to
 * install and the platform-specific labels.
 */

export interface PlatformInstallResult {
  /** true when the install succeeded (exit code 0 / no-op). */
  ok: boolean;
}

export interface PlatformInstaller {
  /** IDE id, matching detectInstalledIDEs(). */
  id: string;
  /** Task/spinner title, e.g. "Codex CLI: installing hooks". */
  title: string;
  /** Success line; the CLI appends the green OK marker. */
  successMessage: string;
  /** Optional dimmed suffix after the OK marker (e.g. Grok's trust hint). */
  successHint?: string;
  /** Failure line; the CLI appends the red FAIL marker. Omit for no-op installers. */
  failureMessage?: string;
  /**
   * Run the install. `message` ticks the spinner. No-op piggyback platforms
   * (claude-code, grok) resolve `ok:true` without side effects. Installers that
   * shell out print to the console; the CLI buffers that and surfaces it only
   * on failure.
   */
  run: (message: (msg: string) => void) => Promise<PlatformInstallResult>;
}

const claudeCodeInstaller: PlatformInstaller = {
  id: 'claude-code',
  title: 'Claude Code: registering plugin',
  successMessage: 'Claude Code: plugin registered',
  // The marketplace + plugin registration is driven by the CLI's shared
  // marketplace step; the per-IDE task only confirms it.
  run: async () => ({ ok: true }),
};

const grokInstaller: PlatformInstaller = {
  id: 'grok',
  title: 'Grok Build: Claude plugin hooks',
  successMessage: 'Grok Build: uses Claude plugin hooks',
  successHint: '(trust folder + /hooks reload)',
  // Grok Build loads Claude Code plugins (including light-mem hooks.json) with
  // camelCase stdin; no separate installer — registering the Claude plugin is
  // sufficient.
  run: async () => ({ ok: true }),
};

const codexInstaller: PlatformInstaller = {
  id: 'codex',
  title: 'Codex CLI: installing hooks',
  successMessage: 'Codex CLI: hooks installed',
  failureMessage: 'Codex CLI: hooks install failed',
  run: async (message) => {
    message('Loading Codex installer…');
    const { installCodexIntegration } = await import('./CodexInstaller.js');
    message('Installing Codex hooks into ~/.codex/hooks.json…');
    return { ok: (await installCodexIntegration()) === 0 };
  },
};

const opencodeInstaller: PlatformInstaller = {
  id: 'opencode',
  title: 'OpenCode: installing plugin integration',
  successMessage: 'OpenCode: plugin integration installed',
  failureMessage: 'OpenCode: plugin integration failed',
  run: async (message) => {
    message('Loading OpenCode installer…');
    const { installOpenCodeIntegration } = await import('./OpenCodeInstaller.js');
    message('Installing OpenCode plugin…');
    return { ok: (await installOpenCodeIntegration()) === 0 };
  },
};

export const PLATFORM_INSTALLERS: Record<string, PlatformInstaller> = {
  'claude-code': claudeCodeInstaller,
  grok: grokInstaller,
  codex: codexInstaller,
  opencode: opencodeInstaller,
};
