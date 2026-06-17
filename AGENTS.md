# light-mem

Lightweight persistent memory system for **Claude Code** and **OpenCode**. It captures
tool-usage observations via lifecycle hooks (Claude Code) or an OpenCode plugin, compresses
them into searchable summaries with the Claude Agent SDK (default) or a direct
Messages API call, embeds them in-process (potion-base-8M + BM25 hybrid search), and
injects relevant context into future sessions. TypeScript, Node ≥24, esbuild-bundled
worker, SQLite via the built-in `node:sqlite`.

## Commands

```bash
npm run build              # sync-plugin-manifests + build-hooks (esbuild bundle + Rule A verify)
npm run build-and-sync     # build, sync to marketplace, restart worker
npm run typecheck          # tsc --noEmit (root + viewer)
npm test                   # vitest run  — MUST run under Node 24 (see AI Instructions)
npm run lint:hook-io       # hook IO-discipline guard
npm run lint:spawn-env     # spawn-env discipline guard
npm run smoke:clean-room   # fresh-install dependency-closure smoke test
```

Detailed command docs: `file:docs/commands.md:BUILD`, `file:docs/commands.md:TEST`,
`file:docs/commands.md:LOCAL_DEV`.

See `file:docs/migrating-from-claude-mem.md` for moving an existing
claude-mem SQLite database to light-mem.

## Architecture

Hooks (`plugin/hooks/hooks.json`) launch a Node worker (`worker-service.cjs`) that owns a
SQLite DB and an MCP search server. Source lives in `src/`; `plugin/` is **build output**.

See `file:docs/architecture.md:OVERVIEW` for the system design.
See `file:docs/architecture.md:DIAGRAM_OVERVIEW` for the architecture diagram.
See `file:docs/architecture.md:COMPONENTS` for component responsibilities.
See `file:docs/claude-providers.md` for the SDK vs API provider choice.
See `file:docs/architecture.md:SERVER_RUNTIME` for the optional multi-tenant server runtime (beta).

## Conventions

See `file:docs/conventions.md:STYLE` for code conventions.
See `file:docs/conventions.md:TESTING` for test patterns (Vitest, Node 24).

## Workflows

See `file:docs/workflows.md:CONTRIBUTING` for the change workflow.
See `file:docs/workflows.md:RELEASE` for the version-bump + release process.
See `file:docs/workflows.md:DAILY_MAINTENANCE` for the dependency-upgrade routine.

## AI Instructions

- **Tests and the worker require Node ≥24** (built-in `node:sqlite`). Under an older Node
  (e.g. nvm default 20) tests crash at `DatabaseSync` import. Run `nvm use 24` first.
- **Do NOT hand-edit `plugin/`** — it is esbuild/build output. Edit `src/` and run
  `npm run build`. The bundled `plugin/scripts/*.cjs` are generated.
- **Do NOT hand-edit `plugin/hooks/hooks.json` or `plugin/.mcp.json`** — the build verifies
  them byte-exact against the canonical template in `scripts/build-hooks.js`
  (`shellTemplateManifest`). Change the generator, then rebuild. This is "Rule A".
- **`plugin/scripts/node-runner.js`** is the hook launcher (an ES module). It must NOT use
  bare `require()` (throws a swallowed `ReferenceError` in ESM) and must NOT use `?.`/`??`
  (it parses on pre-ES2020 Node). See `src/build/hook-shell-template.ts`.
- **Model ids must be provider-valid.** On Bedrock, Direct-API ids (e.g.
  `claude-haiku-4-5-20251001`) 400; use portable aliases (`haiku`/`sonnet`/`opus`) or
  `global.anthropic.*` ids. See `src/npx-cli/install/bedrock-models.ts:1`.
- **Do NOT edit the changelog** — it is generated automatically.
- **Version is single-source from `package.json`.** Never hand-edit a version in
  another manifest or the `.cjs`. Bump via `npm run version:bump[:minor|:major]`
  (runs `sync-plugin-manifests.js`), then `npm run build`. The pre-commit hook
  blocks commits where the version has drifted across manifests or the built
  `.cjs`. See `file:docs/workflows.md:RELEASE`.
- New worker model wiring goes through `src/services/worker/ClaudeProvider.ts:500`
  (`getModelId` → `resolveTierAlias`). If you add a new provider, follow the same
  pattern in `src/services/worker/ClaudeApiProvider.ts:58` (`startSession` signature
  must match `ClaudeProvider.startSession(session, worker?)` — see
  `docs/claude-providers.md`).

## Research

- API-provider resilience design: `file:docs/superpowers/specs/2026-06-17-claude-api-provider-resilience-design.md`

<!-- BETTER-DOCS-META: {"version":"1.0.0","generated":"2026-06-17T21:45:00Z","gitSha":"8b161e16b087b481bfc2b6400f04fbb5fe2dc074","mode":"auto","stack":"typescript-node24-esbuild-vitest-mcp","hasNested":false,"nestedDirs":[]} -->
