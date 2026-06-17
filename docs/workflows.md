# Workflows

<!-- START:CONTRIBUTING -->
1. Branch off `main` (the default branch).
2. Edit `src/` (never `plugin/`). Add or update tests in `tests/`.
3. Gate before committing — all under Node ≥24:
   ```bash
   nvm use 24
   npm run typecheck
   npm run build          # includes Rule A verification
   npm test               # vitest, 0 failures
   npm run lint:hook-io && npm run lint:spawn-env
   ```
4. Commit only when asked. Commit messages end with the project's Co-Authored-By trailer.
<!-- END:CONTRIBUTING -->

<!-- START:COMMIT_FORMAT -->
- Imperative subject summarizing the change, with the version in parens when it bumps
  (e.g. `Fix node-runner.js nvm scan: require() is undefined in ESM (v13.7.3)`).
- Body explains the why and the verification performed.
- Do NOT edit `CHANGELOG.md` — it is generated automatically.
<!-- END:COMMIT_FORMAT -->

<!-- START:RELEASE -->
**Every push to `main` cuts a release automatically** via
`.github/workflows/publish.yml`. There is no manual publish step.

`package.json` is the single source of truth for the version.
`scripts/sync-plugin-manifests.js` propagates it into the other four
version-bearing files (`plugin/package.json`, `.claude-plugin/plugin.json`,
`plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), and the
build bakes it into the worker `.cjs`. The pre-commit hook
(`scripts/install-hooks.sh` → `bump-version.cjs` in verify mode) blocks any
commit where these have drifted.

What CI does on each push to `main`:
1. If `package.json`'s version is already on npm (a plain merge that didn't
   bump) → auto-bump the patch (`bump-version.cjs`), rebuild, and commit the
   bump back to `main` (`chore(release): auto-bump to X [skip ci]`).
2. If it's not yet on npm (a merge that already bumped) → use it as-is.
3. `npm publish` → push tag `vX.Y.Z` → create the GitHub release.

Bump + publish run in the **same** CI job on purpose: a commit pushed with
`GITHUB_TOKEN` does not re-trigger the workflow, so the publish must happen in
the run that does the bump.

To ship a non-patch bump, bump locally before merging — then CI publishes it
as-is rather than auto-bumping:
```bash
npm run version:bump:minor   # or :major — bumps package.json + syncs manifests
npm run build                # bakes the version into the .cjs (verifier needs this)
git commit && git push       # when asked
```
<!-- END:RELEASE -->

<!-- START:CI_CD -->
GitHub Actions in `.github/workflows/`: `ci.yml` (typecheck · build · test · bundle-size +
clean-room dependency smoke + server-runtime Docker e2e), `windows.yml`, `npm-publish.yml`,
`deploy-install-scripts.yml`, `claude.yml`, `summary.yml`, `convert-feature-requests.yml`.

All jobs run on **Node 24** and use **`npm test`** (Vitest). There is no committed root
lockfile, so CI uses `npm install` (not `npm ci`). No Bun is involved (the v13.7.x
Bun→Node migration removed it from the runtime, test runner, and CI).
<!-- END:CI_CD -->

<!-- START:DAILY_MAINTENANCE -->
Daily dependency-currency routine (from the project's development instructions):
- Check `package.json` and nested manifests (`plugin/`) with `npm outdated`.
- Upgrade every package to `latest`, including major bumps
  (`npx npm-check-updates -u && npm install`), then `npm audit fix`.
- Run `npm run build-and-sync`, confirm the worker starts and tests pass; fix any
  major-bump breakage in the same change.
- Commit the updated `package.json` / `package-lock.json`.
<!-- END:DAILY_MAINTENANCE -->
