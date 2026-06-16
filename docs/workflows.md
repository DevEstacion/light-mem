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
Version lives in four manifests that must stay consistent: `package.json`,
`plugin/package.json`, `plugin/.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json`. The build (`sync-plugin-manifests.js`) propagates the
root version into the plugin manifests.

Typical release:
```bash
# bump the three source-of-truth manifests (package.json, plugin/package.json, marketplace.json)
npm run build            # propagates version to plugin.json + verifies Rule A
git commit && git push   # when asked
```
The `light-mem:version-bump` skill automates the full flow (manifests, build, tag, release).
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
