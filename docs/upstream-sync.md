# Upstream Sync Log

Tracks each review of the upstream project [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
for changes worth porting into this rewrite (light-mem).

light-mem is a **from-scratch rewrite** with squashed history (first commit `78f3bf77`,
2026-06-16), conceptually forked from upstream **~v13.6.1**. It is not a shared-history
fork, so there is no `git merge` path — divergence must be reviewed commit-by-commit.

| Date | Upstream SHA reviewed | Upstream version | Decision |
|------|----------------------|------------------|----------|
| 2026-06-26 | `3fe0725a` | v13.8.1 | **Nothing brought over.** See notes below. |

## 2026-06-26 — reviewed `3fe0725a` (v13.8.1)

Reviewed all 19 commits in upstream `v13.6.1..HEAD`. Excluding telemetry/PostHog,
changelog regeneration, and version bumps (none of which this rewrite carries), only
three commits had real signal:

- **`edc5cf7d` — Ponytail audit + worker-restart hardening + deterministic dependency
  closure.** _Skipped — already present._ The worker-restart core (`restart-verify.ts`,
  `worker-shutdown.ts`, the `spawn.lock` gate, `resolveWorkerRuntimePath`, self-replacing
  worker) was authored 2026-06-10, before the rewrite, so it was already absorbed. The
  `bun.lock` dependency-closure half is inapplicable: light-mem is Node-based
  (`node:sqlite`, `node scripts/smoke-clean-room.cjs`), not Bun, and already ships its
  own ported `smoke-clean-room.cjs`.

- **`16b2c72d` — fix(codex): repair startup hooks and stale mcp config.** _Skipped —
  mostly N/A._ Targets `CodexCliInstaller` and `codex-hooks.json`, neither of which
  light-mem has (Codex support is vestigial: a `LIGHT_MEM_CODEX_HOOK=1` env hook in the
  build template, but `build-hooks.js` generates no codex manifest and there is no
  installer). One provider-agnostic sub-change is **latent** here: upstream made
  `buildStatusOutput` omit `suppressOutput` under a Codex hook. light-mem's
  `buildStatusOutput` (`src/services/worker-service.ts:101`) still hardcodes
  `suppressOutput: true`. Harmless until/unless the Codex path is actually wired up;
  not fixed speculatively.

- **`87e4836a` — feat(skills): add `what-the` skill.** _Not brought over._ A 6-line
  plain-English-explanation skill. Zero risk and auto-discovered, but it doesn't fit
  light-mem's memory-focused skill set. Left out by choice.

**Net:** the rewrite is current on everything structural. Upstream divergence since the
fork is almost entirely telemetry (intentionally not carried) plus work already present.
