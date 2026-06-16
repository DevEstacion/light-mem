# Conventions

<!-- START:STYLE -->
- **TypeScript ES modules with `.js` import specifiers** — source files are `.ts` but
  imports reference the compiled `.js` path (e.g. `import { x } from './foo.js'`). Vitest
  resolves this via `extensionAlias`. Keep this convention in new files.
- **`src/` is the source of truth; `plugin/` is build output.** Never hand-edit `plugin/`.
- **Generated launchers are constrained:** `plugin/scripts/node-runner.js` is an ES module
  that must parse on pre-ES2020 Node — no optional chaining (`?.`), no nullish coalescing
  (`??`), and no bare `require()` (undefined in ESM). The build enforces this.
- **Spawn isolation:** subprocess env is built by `src/shared/EnvManager.ts`
  (`buildIsolatedEnv` / `buildIsolatedEnvWithFreshOAuth`). Credentials come from
  `~/.light-mem/.env` or the OAuth keychain, never leaked from the parent shell
  (`BLOCKED_ENV_VARS`). The `lint:spawn-env` guard enforces this.
- **Hook IO discipline:** hooks emit a strict stdout/stderr vocabulary; the `lint:hook-io`
  guard enforces it. See `src/shared/hook-io.ts`.
<!-- END:STYLE -->

<!-- START:TESTING -->
- **Vitest** (`tests/`), Jest-compatible `expect`/`vi`. Migrated off `bun:test`.
- **Run under Node ≥24** — the SQLite layer needs the built-in `node:sqlite`.
- `pool: forks` gives per-file isolation; `tests/vitest.setup.ts` pins
  `LIGHT_MEM_DATA_DIR` to a temp dir before any source module loads (paths freeze
  `DATA_DIR` at first evaluation), so tests never touch the real `~/.light-mem`.
- Source is imported with `.js` specifiers from `tests/` (e.g.
  `import { resolveBedrockModel } from '../../src/npx-cli/install/bedrock-models.js'`).
- Pure functions take injectable inputs (e.g. `resolveBedrockModel(tier, env)`); prefer
  passing an explicit `env` object over mutating `process.env`.
<!-- END:TESTING -->

<!-- START:ERROR_HANDLING -->
- **Model ids must be provider-valid.** A wrong-provider id (e.g. a Direct-API id on
  Bedrock) returns HTTP 400 and the compression batch is silently discarded — capture
  appears to work but nothing is stored. Use portable aliases (`haiku`/`sonnet`/`opus`)
  or provider-native ids. See `src/npx-cli/install/bedrock-models.ts`.
- **Hooks exit 0 on internal errors** to avoid Windows Terminal tab pileup; durable failure
  signals are marker files (e.g. `CAPTURE_BROKEN`), not exit codes.
- **Multi-statement DDL** must go through `exec()`, not `prepare().run()` (the latter runs
  only the first statement) — see `src/services/sqlite/node-sqlite-compat.ts`.
<!-- END:ERROR_HANDLING -->
