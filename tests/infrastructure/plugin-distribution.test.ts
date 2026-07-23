import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf-8'));
}

function commandHooksFrom(relativePath: string): string[] {
  const parsed = readJson(relativePath);
  return Object.values(parsed.hooks ?? {}).flatMap((matchers: any) =>
    matchers.flatMap((matcher: any) =>
      (matcher.hooks ?? [])
        .filter((hook: any) => hook.type === 'command')
        .map((hook: any) => String(hook.command ?? ''))
    )
  );
}

function mcpStartupCommandFrom(relativePath: string): string {
  const parsed = readJson(relativePath);
  return parsed.mcpServers['mcp-search'].args[1];
}

describe('Plugin Distribution - Skills', () => {
  const skillPath = path.join(projectRoot, 'plugin/skills/mem-search/SKILL.md');

  it('should include plugin/skills/mem-search/SKILL.md', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('should have valid YAML frontmatter with name and description', () => {
    const content = readFileSync(skillPath, 'utf-8');

    expect(content.startsWith('---\n')).toBe(true);

    const frontmatterEnd = content.indexOf('\n---\n', 4);
    expect(frontmatterEnd).toBeGreaterThan(0);

    const frontmatter = content.slice(4, frontmatterEnd);
    expect(frontmatter).toContain('name:');
    expect(frontmatter).toContain('description:');
  });

  it('should reference the 3-layer search workflow', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('search');
    expect(content).toContain('timeline');
    expect(content).toContain('get_observations');
  });
});

describe('Plugin Distribution - Required Files', () => {
  const requiredFiles = [
    'plugin/hooks/hooks.json',
    'plugin/.claude-plugin/plugin.json',
    'plugin/.mcp.json',
    'plugin/skills/mem-search/SKILL.md',
    '.agents/plugins/marketplace.json',
  ];

  for (const filePath of requiredFiles) {
    it(`should include ${filePath}`, () => {
      const fullPath = path.join(projectRoot, filePath);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});


describe('Plugin Distribution - hooks.json Integrity', () => {
  it('should have valid JSON in hooks.json', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
  });

  it('should reference CLAUDE_PLUGIN_ROOT in all hook commands', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    }
  });

  it('should include marketplace fallback in all hook commands (#1215)', () => {
    // Pure node -e launcher joins marketplace path segments (no shell $_C/…).
    const expectedFallbackPath = "'marketplaces','light-mem','plugin'";

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(expectedFallbackPath);
    }
  });

  it('should try cache path before marketplaces fallback in all hook commands (#1533)', () => {
    const cachePath = "'cache','light-mem','light-mem'";
    const marketplacesPath = "'marketplaces','light-mem','plugin'";

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(cachePath);
      expect(command.indexOf(cachePath)).toBeLessThan(command.indexOf(marketplacesPath));
    }
  });
});

describe('Plugin Distribution - Startup Root Resolution', () => {
  it('MCP launcher code must not contain shell PATH bootstrap', () => {
    const mcp = readJson('plugin/.mcp.json');
    const args = mcp.mcpServers['mcp-search'].args as string[];

    expect(args[0]).toBe('-e');
    expect(args[1]).not.toContain('export PATH=');
    expect(args[1]).not.toContain('$SHELL');
    expect(args[1]).not.toContain('$PATH');
  });

  it('MCP startup command resolves the plugin root cross-platform (#2792)', () => {
    // The launcher is now a cross-platform `node -e` payload (no `sh`), so it
    // spawns on Windows without Git Bash. It must still resolve the plugin root
    // with config-dir + env fallbacks and try cache roots before marketplaces.
    const command = mcpStartupCommandFrom('plugin/.mcp.json');

    expect(command).toContain('CLAUDE_CONFIG_DIR');
    expect(command).toContain('.claude');
    expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    expect(command).toContain('PLUGIN_ROOT');
    expect(command).toContain('plugins/marketplaces/light-mem/plugin');
    expect(command).toContain('plugins/cache/light-mem/light-mem');
    expect(command).toContain('mcp-server.cjs');
    // No bare absolute "/scripts/..." path leaks through.
    expect(command).not.toContain('"/scripts/mcp-server.cjs"');
    expect(command.indexOf('plugins/cache/light-mem/light-mem')).toBeLessThan(
      command.indexOf('plugins/marketplaces/light-mem/plugin')
    );
  });

  it('Claude hook commands should have config-dir based non-empty fallbacks', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      // Pure node -e launcher (Grok-safe): no shell `$` tokens at all.
      expect(command.startsWith('node -e "')).toBe(true);
      expect(command).not.toContain('$');
      expect(command).toContain('process.env.CLAUDE_CONFIG_DIR');
      expect(command).toContain("p.join(h,'.claude')");
      expect(command).toContain("'cache','light-mem','light-mem'");
      expect(command).toContain("'marketplaces','light-mem','plugin'");
      expect(command).toContain('process.env.CLAUDE_PLUGIN_ROOT');
      expect(command).toContain('process.env.GROK_PLUGIN_ROOT');
    }
  });
});

describe('Plugin Distribution - package.json Files Field', () => {
  it('should include bundled plugin entries in root package.json files field', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('plugin/.mcp.json');
    expect(packageJson.files).toContain('plugin/hooks');
    expect(packageJson.files).toContain('plugin/skills');
    expect(packageJson.files).toContain('plugin/scripts/*.cjs');
  });
});

describe('Plugin Distribution - Build Script Verification', () => {
  it('should verify distribution files in build-hooks.js', () => {
    const buildScriptPath = path.join(projectRoot, 'scripts/build-hooks.js');
    const content = readFileSync(buildScriptPath, 'utf-8');

    expect(content).toContain('plugin/skills/mem-search/SKILL.md');
    expect(content).toContain('plugin/hooks/hooks.json');
    expect(content).toContain('plugin/.claude-plugin/plugin.json');
  });
});

describe('Plugin Distribution - Setup Hook (#1547)', () => {
  it('should not reference removed setup.sh in Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).not.toContain('setup.sh');
  });

  it('should call version-check.js in the Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const setupHooks: any[] = parsed.hooks['Setup'] ?? [];

    const commandHooks = setupHooks.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((h: any) => h.type === 'command')
    );

    expect(commandHooks.length).toBeGreaterThan(0);

    const versionCheckHooks = commandHooks.filter((h: any) =>
      h.command?.includes('version-check.js')
    );
    expect(versionCheckHooks.length).toBeGreaterThan(0);
  });

  it('version-check.js referenced by Setup hook should exist on disk', () => {
    const versionCheckPath = path.join(projectRoot, 'plugin/scripts/version-check.js');
    expect(existsSync(versionCheckPath)).toBe(true);
  });

  // The Setup event only fires under `claude --init-only` / `-p --init` — never
  // on a normal launch, plugin install, update, or /reload-plugins (verified
  // against the Claude Code hooks docs). version-check.js does the tree-sitter
  // CLI binary backfill + missing-dep install, so wiring it ONLY to Setup means
  // it never runs in practice (the binary went missing after every marketplace
  // update). It MUST also run on SessionStart. Guards against silent regression
  // back to Setup-only.
  it('should also call version-check.js on SessionStart (Setup almost never fires)', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const sessionStart: any[] = parsed.hooks['SessionStart'] ?? [];

    const commandHooks = sessionStart.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((h: any) => h.type === 'command')
    );
    const versionCheckHooks = commandHooks.filter((h: any) =>
      h.command?.includes('version-check.js')
    );
    expect(versionCheckHooks.length).toBeGreaterThan(0);
    // Must be detached so it doesn't block the 60s SessionStart hook timeout.
    // Node launcher uses spawn({detached:true}) + unref() instead of nohup.
    expect(versionCheckHooks.every((h: any) =>
      h.command?.includes('detached:true') && h.command?.includes('unref()')
    )).toBe(true);
  });

  // Grok Build expands $VAR / ${VAR} in hook command strings before spawn and
  // fail-skips when a required var is unset (docs.x.ai/build/features/hooks).
  // Hook commands must be pure `node -e` launchers with ZERO `$` characters.
  it('hook commands must be Grok-safe node -e launchers (no $ tokens)', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const commands: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const rec = node as Record<string, unknown>;
      if (typeof rec.command === 'string') commands.push(rec.command);
      Object.values(rec).forEach(walk);
    };
    walk(parsed.hooks);

    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd.startsWith('node -e "')).toBe(true);
      expect(cmd).not.toContain('$');
    }
    const post = commands.find((c) => c.includes('observation'));
    expect(post).toBeTruthy();
    expect(post!).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(post!).toContain('process.env.GROK_PLUGIN_ROOT');
  });
});

// ---------------------------------------------------------------------------
// Spawn-contract templating (plans/02-spawn-contract-templating.md)
// ---------------------------------------------------------------------------

const ccTrailing = (...tail: string[]) => [
  'node', '"$_P/scripts/node-runner.js"', '"$_P/scripts/worker-service.cjs"', ...tail,
];
const claudeHook = (tail: string[], extra: Record<string, unknown> = {}) => buildShellCommand({
  host: 'claude-code', requireFile: 'node-runner.js', requireFileSecondary: 'worker-service.cjs',
  trailingCommand: ccTrailing(...tail), notFoundMessage: 'light-mem: plugin scripts not found', ...extra,
});
const RULE_A_EXPECTATIONS: Record<string, Record<string, string>> = {
  'plugin/hooks/hooks.json': {
    'Setup.0.0': buildShellCommand({
      host: 'claude-code-setup', requireFile: 'version-check.js',
      trailingCommand: ['node', '"$_P/scripts/version-check.js"'],
      notFoundMessage: 'light-mem: version-check.js not found',
    }),
    'SessionStart.0.0': claudeHook(['start'], { trailingJson: { continue: true, suppressOutput: true } }),
    'SessionStart.0.1': claudeHook(['hook', 'claude-code', 'context']),
    'SessionStart.0.2': buildShellCommand({
      host: 'claude-code', requireFile: 'version-check.js',
      trailingCommand: ['node', '"$_P/scripts/version-check.js"'],
      notFoundMessage: 'light-mem: version-check.js not found',
      background: true,
    }),
    'UserPromptSubmit.0.0': claudeHook(['hook', 'claude-code', 'session-init']),
    'PostToolUse.0.0': claudeHook(['hook', 'claude-code', 'observation']),
    'PreToolUse.0.0': claudeHook(['hook', 'claude-code', 'file-context']),
    'Stop.0.0': claudeHook(['hook', 'claude-code', 'summarize']),
  },
};

const MCP_EXPECTED = buildShellCommand({
  // The mcp Node launcher derives its spawn target from requireFile; it ignores
  // trailingCommand, so none is passed (see buildMcpNodeLauncher).
  host: 'mcp', requireFile: 'mcp-server.cjs',
  notFoundMessage: 'light-mem: mcp server not found',
  mcpExtraCandidates: ['$PWD/plugin', '$PWD'],
});

function hookCommandByPath(parsed: any, dottedPath: string): string | null {
  const [event, groupIdx, hookIdx] = dottedPath.split('.');
  return parsed.hooks?.[event]?.[Number(groupIdx)]?.hooks?.[Number(hookIdx)]?.command ?? null;
}

describe('Spawn-Contract Templating - Rule A generator parity', () => {
  for (const [filePath, commands] of Object.entries(RULE_A_EXPECTATIONS)) {
    for (const [dottedPath, expected] of Object.entries(commands)) {
      it(`${filePath} [${dottedPath}] equals buildShellCommand output`, () => {
        const parsed = readJson(filePath);
        const actual = hookCommandByPath(parsed, dottedPath);
        expect(actual).toBe(expected);
      });
    }
  }

  it('plugin/.mcp.json mcp-search command equals buildShellCommand output', () => {
    const parsed = readJson('plugin/.mcp.json');
    expect(parsed.mcpServers['mcp-search'].args[1]).toBe(MCP_EXPECTED);
  });

  it('never leaks shell ${CLAUDE_PLUGIN_ROOT} tokens into hook commands', () => {
    // Hook launchers read env via process.env — never shell ${…} / $VAR.
    const shCommands = Object.values(RULE_A_EXPECTATIONS).flatMap((c) => Object.values(c));
    for (const command of shCommands) {
      expect(command).not.toContain('$');
      expect(command).toContain('process.env.CLAUDE_PLUGIN_ROOT');
      expect(command).toContain('process.env.GROK_PLUGIN_ROOT');
      expect(command).toContain('process.env.PLUGIN_ROOT');
    }
    expect(MCP_EXPECTED).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(MCP_EXPECTED).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(MCP_EXPECTED).toContain('process.env.PLUGIN_ROOT');
  });
});

describe('Spawn-Contract Templating - Rule A node launcher resolution matrix', () => {
  // Evaluate the generated `node -e` launchers across resolution sources:
  // (a) CLAUDE_PLUGIN_ROOT injected, (b) cache fallback hit, (c) all miss.
  // Replace the spawn tail with console.log("RESOLVED="+R).

  function extractProgram(command: string): string {
    expect(command.startsWith('node -e "')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
    const inner = command.slice('node -e "'.length, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  function instrument(command: string): string {
    const program = extractProgram(command);
    // Do NOT match `const r=` inside the discovery for-loop (`for(const k of K){const r=…}`).
    // Only cut at the spawn tail.
    const cut = program.search(/const argv=|const ch=c\.spawn|const r=c\.spawnSync/);
    const discovery = cut >= 0 ? program.slice(0, cut) : program;
    const instrumented = `${discovery}console.log("RESOLVED="+R);`;
    expect(instrumented).not.toContain('$');
    const reescaped = instrumented.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `node -e "${reescaped}"`;
  }

  function nodeEval(command: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
    const program = extractProgram(command);
    const result = spawnSync(process.execPath, ['-e', program], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf-8',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  const claudeCommands = () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    return Object.entries(RULE_A_EXPECTATIONS['plugin/hooks/hooks.json']).map(
      ([dottedPath]) => ({ dottedPath, command: hookCommandByPath(parsed, dottedPath)! })
    );
  };

  it('resolves R from CLAUDE_PLUGIN_ROOT when the env var points at a valid root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-root-'));
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'version-check.js'), '');
    writeFileSync(path.join(root, 'scripts', 'node-runner.js'), '');
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '');
    try {
      for (const { command } of claudeCommands()) {
        const { stdout } = nodeEval(instrument(command), {
          CLAUDE_PLUGIN_ROOT: root,
          HOME: mkdtempSync(path.join(tmpdir(), 'cm-home-')),
        });
        expect(stdout).toContain(`RESOLVED=${root}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves R from the cache directory when CLAUDE_PLUGIN_ROOT is unset', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'light-mem', 'light-mem', '99.0.0');
    mkdirSync(path.join(cacheRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(cacheRoot, 'scripts', 'version-check.js'), '');
    writeFileSync(path.join(cacheRoot, 'scripts', 'node-runner.js'), '');
    writeFileSync(path.join(cacheRoot, 'scripts', 'worker-service.cjs'), '');
    try {
      for (const { command } of claudeCommands()) {
        const { stdout } = nodeEval(instrument(command), { HOME: home });
        expect(stdout).toContain(`RESOLVED=${cacheRoot}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails cleanly with the canonical not-found message when no candidate exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-empty-'));
    try {
      const parsed = readJson('plugin/hooks/hooks.json');
      const command = hookCommandByPath(parsed, 'UserPromptSubmit.0.0')!;
      const result = nodeEval(command, { HOME: home });
      expect(result.status).not.toBe(0);
      expect(result.stderr ?? '').toMatch(/light-mem: .* not found/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Spawn-Contract Templating - Rule B installers bake absolute paths', () => {
  const installerFiles = [
    'src/services/integrations/McpIntegrations.ts',
  ];

  for (const file of installerFiles) {
    it(`${file} emits no raw \${CLAUDE_PLUGIN_ROOT} placeholder`, () => {
      const content = readFileSync(path.join(projectRoot, file), 'utf-8');
      expect(content).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    });
  }

  it('install-paths.ts centralizes the Rule B helpers', () => {
    const content = readFileSync(
      path.join(projectRoot, 'src/services/integrations/install-paths.ts'),
      'utf-8',
    );
    for (const name of [
      'getMcpServerAbsolutePath',
      'getWorkerServiceAbsolutePath',
      'getNodeAbsolutePath',
      'getPluginRootAbsolutePath',
      'getVersionCheckAbsolutePath',
    ]) {
      expect(content).toContain(`export function ${name}`);
    }
  });
});
