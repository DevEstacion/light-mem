# Hook Node PATH Regression Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Claude, Grok, Codex, and MCP pure Node launchers so hooks retain PATH and MCP code parses.

**Architecture:** `buildShellCommand()` already selects reusable Node launcher builders. Return selected builder result unchanged. Existing distribution tests enforce `node -e` plus Grok-safe zero-dollar contract; add direct builder coverage before changing source.

**Tech Stack:** TypeScript, Vitest, Node 24+, esbuild build script.

## Global Constraints

- Edit `src/`; never hand-edit `plugin/` generated output.
- Run tests under Node 24 or newer.
- Preserve Rule A byte-exact generated manifests via `npm run build`.
- No shell PATH bootstrap, absolute Node path, dependency, or API addition.

---

### Task 1: Lock pure launcher contract

**Files:**
- Modify: `tests/infrastructure/plugin-distribution.test.ts`
- Test: `tests/infrastructure/plugin-distribution.test.ts`

**Interfaces:**
- Consumes: generated `plugin/hooks/hooks.json`, `plugin/.mcp.json`.
- Produces: regression test proving hook commands are direct pure `node -e` commands and MCP launch JavaScript begins with an expression, not shell `export`.

- [ ] **Step 1: Write failing test**

Add test beside existing hook command checks:

```ts
it('MCP launcher code must not contain shell PATH bootstrap', () => {
  const mcp = JSON.parse(readFileSync(path.join(projectRoot, 'plugin/.mcp.json'), 'utf-8'));
  const args = mcp.mcpServers['light-mem'].args as string[];

  expect(args[0]).toBe('-e');
  expect(args[1]).not.toContain('export PATH=');
  expect(args[1]).not.toContain('\\$SHELL');
  expect(args[1]).not.toContain('\\$PATH');
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
nvm use 24 && ./node_modules/.bin/vitest run tests/infrastructure/plugin-distribution.test.ts --reporter=dot
```

Expected: new test fails because generated MCP code contains `export PATH=`.

- [ ] **Step 3: Do not change production code yet**

Confirm existing hook `node -e` and zero-dollar tests also fail. This proves test detects existing regression.

### Task 2: Restore direct reusable launcher output

**Files:**
- Modify: `src/build/hook-shell-template.ts:221-239`
- Generated: `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/.mcp.json`
- Test: `tests/infrastructure/plugin-distribution.test.ts`

**Interfaces:**
- Consumes: `buildMcpNodeLauncher(options): string`, `buildHookNodeLauncher(options): string`.
- Produces: `buildShellCommand(options): string` that returns selected launcher directly.

- [ ] **Step 1: Apply minimal implementation**

Replace body documentation and return with:

```ts
/**
 * Build the full single-line command string for a Rule A site.
 *
 * - `mcp` → pure Node MCP launcher (`.mcp.json` args[1])
 * - all hook hosts → pure Node hook launcher (Grok/Claude/Codex safe)
 */
export function buildShellCommand(options: ShellTemplateOptions): string {
  return options.host === 'mcp'
    ? buildMcpNodeLauncher(options)
    : buildHookNodeLauncher(options);
}
```

- [ ] **Step 2: Rebuild generated artifacts**

Run:

```bash
nvm use 24 && npm run build
```

Expected: build exits 0 and rewrites generated launcher manifests from source.

- [ ] **Step 3: Verify targeted regression suite**

Run:

```bash
nvm use 24 && ./node_modules/.bin/vitest run tests/infrastructure/plugin-distribution.test.ts --reporter=dot
```

Expected: all tests pass.

- [ ] **Step 4: Verify exact output properties**

Run:

```bash
node -e "const h=require('./plugin/hooks/hooks.json'); const c=Object.values(h.hooks).flatMap(v=>v.flatMap(x=>x.hooks||[])).map(x=>x.command).filter(Boolean); if (!c.every(x=>x.startsWith('node -e \"')&&!x.includes('$'))) process.exit(1); const m=require('./plugin/.mcp.json').mcpServers['light-mem'].args[1]; if (m.includes('export PATH=')) process.exit(1)"
```

Expected: exit 0.

- [ ] **Step 5: Commit implementation**

```bash
git add src/build/hook-shell-template.ts tests/infrastructure/plugin-distribution.test.ts plugin/hooks/hooks.json plugin/hooks/codex-hooks.json plugin/.mcp.json
git commit -m "fix(hooks): restore pure Node launchers" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: Verify distribution and push branch

**Files:**
- Inspect: source, generated manifests, test output.

**Interfaces:**
- Consumes: Task 2 commit.
- Produces: verified branch pushed to origin.

- [ ] **Step 1: Run typecheck**

```bash
nvm use 24 && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run full test suite**

```bash
nvm use 24 && npm test
```

Expected: exit 0.

- [ ] **Step 3: Inspect final diff and status**

```bash
git status --short && git diff main...HEAD --check && git log --oneline main..HEAD
```

Expected: no whitespace errors; only spec and launcher fix commits.

- [ ] **Step 4: Push branch**

```bash
git push -u origin worktree-fix-hook-node-path-regression
```

Expected: remote branch creation succeeds.
