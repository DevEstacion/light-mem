# Commands

<!-- START:BUILD -->
```bash
npm run build           # sync-plugin-manifests.js + build-hooks.js
npm run build-and-sync  # build, sync to ~/.claude/plugins/marketplaces/light-mem, restart worker
```

`scripts/build-hooks.js` does the real work: esbuild-bundles the worker, MCP server,
context generator, and transcript watcher into self-contained `plugin/scripts/*.cjs`,
copies the potion model assets into `plugin/models/`, and runs **Rule A** verification —
asserting `plugin/hooks/hooks.json` and `plugin/.mcp.json` match the canonical command
template byte-exact. A hand-edit to those generated files fails the build.

`scripts/sync-plugin-manifests.js` propagates the version from `package.json` into the
plugin manifests so all version strings stay consistent.
<!-- END:BUILD -->

<!-- START:TEST -->
```bash
npm test                # vitest run (full suite)
npm run test:watch      # vitest watch mode
npm run test:sqlite     # tests/sqlite/
npm run test:infra      # tests/infrastructure/
npm run test:search     # tests/worker/search/
```

**Tests MUST run under Node ≥24.** Vitest config uses `pool: forks` for per-file
isolation; `tests/vitest.setup.ts` pins `LIGHT_MEM_DATA_DIR` to a temp dir so no test
touches the real `~/.light-mem`. Under an older Node, suites that import the SQLite layer
crash at `DatabaseSync` (the built-in `node:sqlite` is absent).
<!-- END:TEST -->

<!-- START:LINT -->
```bash
npm run typecheck       # tsc --noEmit (root + src/ui/viewer)
npm run lint:hook-io    # hook stdout/stderr IO-discipline guard
npm run lint:spawn-env  # spawn-env discipline guard
```

There is no ESLint/Prettier gate; `tsc` plus the two discipline guards are the lint layer.
<!-- END:LINT -->

<!-- START:LOCAL_DEV -->
```bash
# Worker lifecycle (against the installed plugin)
npm run worker:start | worker:stop | worker:restart | worker:status
npm run worker:logs            # tail today's worker log

# Queue inspection (dev tsx scripts)
npm run queue                  # show pending queue
npm run queue:process          # drain it

# Fresh-install regression backstop
npm run smoke:clean-room       # installs into throwaway temp dirs, boots the worker
```

Iterate by editing `src/`, running `npm run build-and-sync`, and watching `worker:logs`.
The installed plugin lives at `~/.claude/plugins/marketplaces/light-mem/`; data and logs
live under `~/.light-mem/`.
<!-- END:LOCAL_DEV -->
