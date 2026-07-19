/**
 * hook-shell-template.ts — Rule A: host-managed defensive shell-template
 * generator (single source of truth).
 *
 * See `CLAUDE.md` → "Spawn-Contract Resolution". The host-owned config files
 * (`plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`,
 * `plugin/.mcp.json`) embed a launcher that resolves the plugin root from
 * host-injected env (`CLAUDE_PLUGIN_ROOT` / `GROK_PLUGIN_ROOT` / `PLUGIN_ROOT`),
 * then falls back through the host cache directories and the marketplace install
 * dir. Some host versions / cache rotations do NOT inject the env var, so the
 * fallback chain is load-bearing (issues #1215, #1533).
 *
 * Grok Build pre-expands `$VAR` / `${VAR}` in hook `command` strings and
 * fail-skips when a required var is unset (docs.x.ai/build/features/hooks).
 * Shell-local tokens like `$_R` / `$_P` are never in the environment, so any
 * shell prelude is incompatible with Grok. Claude / Codex / Setup hooks
 * therefore use a pure `node -e` launcher with ZERO `$` characters.
 *
 * The fallback chain ORDER is contractual and must not change:
 *   1. CLAUDE_PLUGIN_ROOT / GROK_PLUGIN_ROOT / PLUGIN_ROOT (host-injected env)
 *   2. (mcp only) $PWD/plugin, $PWD               (repo/dev checkout)
 *   3. cache directories (newest first via mtime)
 *   4. marketplaces/light-mem/plugin (marketplace install)
 */

export type ShellTemplateHost = 'claude-code' | 'claude-code-setup' | 'codex-cli' | 'mcp';

export interface ShellTemplateOptions {
  /** Host whose spawn contract / PATH prelude applies. */
  host: ShellTemplateHost;
  /** Script that must exist under `<root>/scripts/` for the root to count. */
  requireFile: string;
  /** Optional second required script (hooks needing node-runner.js AND worker-service.cjs). */
  requireFileSecondary?: string;
  /**
   * Trailing command tokens. For Claude/Codex hooks this is typically:
   *   `node "$_P/scripts/node-runner.js" "$_P/scripts/worker-service.cjs" …args`
   * The Node launcher rewrites `$_P/scripts/X` tokens to absolute paths after
   * resolving the plugin root. Required for every non-mcp host.
   */
  trailingCommand?: string[];
  /** Extra env exports on the spawned process (e.g. LIGHT_MEM_CODEX_HOOK=1). */
  extraEnv?: Record<string, string>;
  /** Optional trailing JSON echoed after the command (e.g. SessionStart continue marker). */
  trailingJson?: object;
  /**
   * Run the trailing command detached so the hook returns immediately and never
   * blocks the host's hook timeout. Used by the SessionStart backfill of
   * version-check.js.
   */
  background?: boolean;
  /** stderr message when no candidate root resolves. */
  notFoundMessage: string;
  /**
   * MCP-only: extra candidate roots enumerated before the cache directories
   * (e.g. '$PWD/plugin', '$PWD'). Ignored for non-mcp hosts.
   */
  mcpExtraCandidates?: string[];
  /**
   * MCP-only: additional cache roots tried (newest first) BEFORE the Claude
   * cache root (e.g. Codex caches). Each entry is the cache root WITHOUT the
   * version-glob suffix (/[0-9]asterisk/), which the generator appends
   * uniformly. Ignored for non-mcp hosts.
   */
  mcpExtraCacheRoots?: string[];
}

/**
 * Translate a shell-token candidate (`$PWD`, `$PWD/x`, `$HOME/x`, `$_C/x`) into
 * an equivalent Node path expression for the cross-platform MCP launcher.
 * `d` = process.cwd(), `h` = os.homedir(), `C` = resolved CLAUDE_CONFIG_DIR.
 */
function shTokenToNode(token: string): string {
  if (token === '$PWD') return 'd';
  const map: Array<[string, string]> = [
    ['$PWD/', 'd'],
    ['$HOME/', 'h'],
    ['$_C/', 'C'],
  ];
  for (const [prefix, base] of map) {
    if (token.startsWith(prefix)) {
      return `p.join(${base},${JSON.stringify(token.slice(prefix.length))})`;
    }
  }
  // Literal fallback (no known shell base) — embed as-is.
  return JSON.stringify(token);
}

/**
 * Cross-platform MCP launcher (issues #2792, #2790, #2714, #2461). The plugin
 * `.mcp.json` previously used `command: "sh"`, which Claude Code cannot spawn on
 * Windows when Git's `usr/bin` is not on PATH, so the search tools never
 * registered. This emits the `node -e` payload (`.mcp.json` args[1]) that does
 * the same plugin-root discovery in pure Node — no shell dependency — then
 * spawns the resolved server and forwards signals.
 */
function buildMcpNodeLauncher(options: ShellTemplateOptions): string {
  const candidates = (options.mcpExtraCandidates ?? []).map(shTokenToNode);
  const cacheRoots = [
    ...(options.mcpExtraCacheRoots ?? []),
    '$_C/plugins/cache/light-mem/light-mem',
  ].map(shTokenToNode);
  const marketplace = shTokenToNode('$_C/plugins/marketplaces/light-mem/plugin');
  const require = JSON.stringify(options.requireFile);
  const notFound = JSON.stringify(`${options.notFoundMessage}\n`);

  const kParts = [
    'E',
    ...candidates,
    ...cacheRoots.map((root) => `...L(${root})`),
    marketplace,
  ].join(',');

  return (
    `const f=require('fs'),p=require('path'),o=require('os'),c=require('child_process');` +
    `const h=o.homedir();` +
    `const C=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');` +
    `const E=process.env.CLAUDE_PLUGIN_ROOT||process.env.GROK_PLUGIN_ROOT||process.env.PLUGIN_ROOT||'';` +
    `const d=process.cwd();` +
    `const L=x=>{try{return f.readdirSync(x).filter(n=>/^\\d/.test(n)).map(n=>p.join(x,n)).filter(z=>{try{return f.statSync(z).isDirectory()}catch{return false}}).sort((a,b)=>f.statSync(b).mtimeMs-f.statSync(a).mtimeMs)}catch{return[]}};` +
    `const K=[${kParts}].filter(Boolean);` +
    `let R=null;` +
    `for(const k of K){const r=f.existsSync(p.join(k,'plugin','scripts'))?p.join(k,'plugin'):k;if(f.existsSync(p.join(r,'scripts',${require}))){R=r;break}}` +
    `if(!R){process.stderr.write(${notFound});process.exit(1)}` +
    `const ch=c.spawn(process.execPath,[p.join(R,'scripts',${require})],{stdio:'inherit'});` +
    `for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>{try{ch.kill(s)}catch{}});` +
    `ch.on('exit',(code,sig)=>{if(sig){process.removeAllListeners(sig);try{process.kill(process.pid,sig)}catch{process.exit(1)}}else process.exit(code==null?0:code)})`
  );
}

/**
 * Parse trailingCommand tokens into script basenames + CLI args.
 * Accepts historical shell forms: `node "$_P/scripts/foo.js" bar`.
 */
function parseTrailingCommand(trailingCommand: string[]): {
  spawnFiles: string[];
  spawnArgs: string[];
} {
  const spawnFiles: string[] = [];
  const spawnArgs: string[] = [];
  for (const raw of trailingCommand) {
    if (raw === 'node') continue;
    const unquoted = raw.replace(/^"/, '').replace(/"$/, '');
    const m = unquoted.match(/^\$_P\/scripts\/(.+)$/);
    if (m) {
      spawnFiles.push(m[1]);
      continue;
    }
    spawnArgs.push(unquoted);
  }
  if (spawnFiles.length === 0) {
    throw new Error(
      'buildHookNodeLauncher: trailingCommand must include at least one "$_P/scripts/…" token',
    );
  }
  return { spawnFiles, spawnArgs };
}

/**
 * Pure-Node hook launcher (Grok Build compatible).
 *
 * Emits `node -e "…"` with **zero `$` characters**. Grok pre-expands `$VAR` /
 * `${VAR}` in hook command strings and fail-skips when unset; shell-local
 * `$_R` / `$_P` therefore never work under Grok even after dropping braces.
 */
function buildHookNodeLauncher(options: ShellTemplateOptions): string {
  if (!options.trailingCommand) {
    throw new Error(`buildHookNodeLauncher: host '${options.host}' requires trailingCommand`);
  }
  if (options.background && options.trailingJson) {
    throw new Error('buildHookNodeLauncher: background and trailingJson are mutually exclusive');
  }

  const { spawnFiles, spawnArgs } = parseTrailingCommand(options.trailingCommand);

  const requiredScripts = [
    options.requireFile,
    ...(options.requireFileSecondary ? [options.requireFileSecondary] : []),
  ];

  const notFound = JSON.stringify(`${options.notFoundMessage}\n`);
  const requiredJson = JSON.stringify(requiredScripts);
  const filesJson = JSON.stringify(spawnFiles);
  const argsJson = JSON.stringify(spawnArgs);
  const extraEnvJson = JSON.stringify(options.extraEnv ?? {});
  // Double-encode so the value is a JS string literal expression.
  const trailingJsonExpr = options.trailingJson
    ? JSON.stringify(JSON.stringify(options.trailingJson))
    : 'null';

  const program = [
    `const f=require('fs'),p=require('path'),o=require('os'),c=require('child_process');`,
    `const h=o.homedir();`,
    `const C=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');`,
    `const E=process.env.CLAUDE_PLUGIN_ROOT||process.env.GROK_PLUGIN_ROOT||process.env.PLUGIN_ROOT||'';`,
    `const L=x=>{try{return f.readdirSync(x).filter(n=>/^\\d/.test(n)).map(n=>p.join(x,n)).filter(z=>{try{return f.statSync(z).isDirectory()}catch{return false}}).sort((a,b)=>f.statSync(b).mtimeMs-f.statSync(a).mtimeMs)}catch{return[]}};`,
    `const K=[E,...L(p.join(C,'plugins','cache','light-mem','light-mem')),p.join(C,'plugins','marketplaces','light-mem','plugin')].filter(Boolean);`,
    `const need=${requiredJson};`,
    `let R=null;`,
    `for(const k of K){const r=f.existsSync(p.join(k,'plugin','scripts'))?p.join(k,'plugin'):k;if(need.every(s=>f.existsSync(p.join(r,'scripts',s)))){R=r;break}}`,
    `if(!R){process.stderr.write(${notFound});process.exit(1)}`,
    `const argv=${filesJson}.map(s=>p.join(R,'scripts',s)).concat(${argsJson});`,
    `const env=Object.assign({},process.env,${extraEnvJson});`,
    options.background
      ? `const ch=c.spawn(process.execPath,argv,{stdio:'ignore',detached:true,env:env});ch.unref();process.exit(0);`
      : `const r=c.spawnSync(process.execPath,argv,{stdio:'inherit',env:env});const j=${trailingJsonExpr};if(j)process.stdout.write(j+'\\n');process.exit(r.status==null?1:r.status);`,
  ].join('');

  // Hard guard: any `$` would re-trigger Grok's required-env preflight.
  if (program.includes('$')) {
    const i = program.indexOf('$');
    throw new Error(
      `buildHookNodeLauncher: generated program still contains $ near: ${JSON.stringify(program.slice(Math.max(0, i - 24), i + 24))}`,
    );
  }

  const escaped = program.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `node -e "${escaped}"`;
}

/**
 * Build the full single-line command string for a Rule A site.
 *
 * - `mcp` → pure Node MCP launcher (`.mcp.json` args[1])
 * - all hook hosts → pure Node hook launcher (Grok/Claude/Codex safe)
 */
export function buildShellCommand(options: ShellTemplateOptions): string {
  if (options.host === 'mcp') {
    return buildMcpNodeLauncher(options);
  }
  return buildHookNodeLauncher(options);
}
