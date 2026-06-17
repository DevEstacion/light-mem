# Publishing light-mem to npmjs

This repo publishes to npmjs automatically via GitHub Actions. Once the workflow
is configured, releases happen on every push to `main` that bumps
`package.json`'s `version` field — no manual `npm publish` needed.

The version bump itself happens in two places:

1. **Locally**, on every commit, by a git `pre-commit` hook that runs
   `scripts/bump-version.cjs`. It bumps the patch number (e.g. `0.1.0` → `0.1.1`)
   and re-stages the change into your commit.
2. **On every push to `main`**, GitHub Actions compares `package.json`'s version
   against the latest version on the registry. If it's strictly newer, it
   publishes to npm, creates a `v<version>` git tag, and opens a GitHub release.

The hook does NOT push, tag, or publish. It only edits files. CI does the rest.

## First-time setup

You do this once per machine / per repo. Steps in execution order:

### 1. Install the git hook

```bash
npm run hooks:install
```

This writes `.git/hooks/pre-commit`. After this, every `git commit` will
auto-bump the patch version. To remove it later: `bash scripts/install-hooks.sh --uninstall`.

### 2. Get an npm Automation token

This is the **Automation** token, not a publish token and not your login
password. The Automation token bypasses 2FA and is what GitHub Actions uses.

a. Log in to npmjs.com in your browser.

b. Go to **Account Settings → Access Tokens → Generate New Token → Automation**.

   - Name it `light-mem-ci` (or anything you can recognize later).
   - **Automation** is the right "type" — it can publish packages but does
     not require 2FA on every publish, which is what you want for CI.
   - The other types you'll see are **Publish** (single package, scoped, needs
     2FA per publish) and **Read-Only**. Don't pick those.

c. Copy the token immediately. npm shows it **once**. If you navigate away
   you have to regenerate.

### 3. Add the token to GitHub Secrets

a. In your fork, go to **Settings → Secrets and variables → Actions →
   New repository secret**.

b. Name: `NPM_TOKEN` (must match exactly — the workflow references
   `secrets.NPM_TOKEN`).

c. Value: paste the token from step 2.

d. Save.

The secret is available only to workflows in this repository, and is never
logged. GitHub redacts it from workflow output automatically.

### 4. Enable write permission for `GITHUB_TOKEN`

The workflow creates git tags, which needs `contents: write`. If your
repository's "Workflow permissions" setting is "Read repository contents and
packages", this will silently fail at the `git push origin v...` step.

a. In your fork, go to **Settings → Actions → General → Workflow permissions**.

b. Select **"Read and write permissions"**. (Or keep "Read only" and instead
   add `contents: write` to the `permissions:` block — already done in
   `.github/workflows/publish.yml` — and grant the workflow that scope via
   "Allow GitHub Actions to create and approve pull requests" + a custom
   permissions rule. Simpler to just enable write for all workflows on this
   repo.)

c. Save.

### 5. First publish

```bash
git add package.json .claude-plugin/marketplace.json .github/workflows scripts/
git commit -m "chore: publish v0.1.0 — initial npm release"
git push origin main
```

The pre-commit hook will bump your `package.json` from `0.1.0` to `0.1.1`
before the commit lands. Push that to main. The workflow:

1. Reads `package.json` → sees `0.1.1`.
2. Calls `npm view light-mem@0.1.1 version` → empty (not yet on registry).
3. Runs `npm ci` and `npm run build`.
4. `npm publish --access public` → first version is now on npm.
5. Creates git tag `v0.1.1` and pushes it.
6. Opens a GitHub release with auto-generated notes.

> **Why `0.1.1` and not `0.1.0`?** The pre-commit hook bumps on the commit
> that *introduces* the publish workflow too — that's the first time it
> runs. So your first "publish" lands as `0.1.1`, not `0.1.0`. If you want
> the first published version to be `0.1.0` exactly, commit the publish
> workflow without the hook installed (i.e. skip `npm run hooks:install`
> for that one commit), or hand-edit `package.json` back to `0.1.0`
> after the bump and commit a no-op version-sync commit. Either works.

### Manual publish (retry / hotfix)

If you need to republish the same version (rare — npm forbids re-publishing
the exact same version) or force-publish a specific version, use
**Actions → publish → Run workflow** in the GitHub UI. Manual runs skip
nothing — they go through the same build + publish path.

## Troubleshooting

**"npm error code E404 — Not Found" on the very first publish.**

This is expected. The "Resolve published version" step treats 404 as "first
publish" and continues. If you see this error AFTER a successful publish,
something raced. Re-run the workflow manually.

**"npm error code E403 — You do not have permission to publish".**

Your `NPM_TOKEN` secret is either missing, expired, or has the wrong scope.
Regenerate an **Automation** token at npmjs.com → Access Tokens and replace
the GitHub secret.

**"git push origin v0.1.1" fails with "denied to github-actions[bot]".**

You skipped step 4. The workflow needs `contents: write` to push tags.

**"npm ci" fails with "EUSAGE — There is no lockfile".**

Generate and commit a lockfile once. Run locally:

```bash
npm install
git add package-lock.json
git commit -m "chore: commit package-lock.json for reproducible CI installs"
```

(`.gitignore` previously excluded it; that's now uncommented.) Push, and the
workflow will succeed on the next main push.

**Pre-commit hook is silent on every commit.**

The hook is idempotent: if `package.json` already differs from `HEAD`'s
`package.json`, the hook skips. That's intentional — it prevents double-bumps.
If you want to force a bump, run `npm run version:bump` (patch) /
`version:bump:minor` / `version:bump:major` manually.

**I want to do a manual `npm publish` from my laptop.**

You can, but you need a different token (a **Publish** token, scoped to a
single package, requires 2FA per publish). The flow is:

```bash
npm login           # prompts for OTP if 2FA is on
npm run build
npm publish --access public
```

This is the escape hatch when CI is down. Prefer the GitHub Actions path
otherwise — it produces the git tag and GitHub release for free.

## Anatomy of a release

1. You commit code on a feature branch.
2. Pre-commit hook bumps `package.json` from, say, `0.1.7` to `0.1.8` and
   adds the bump to your commit.
3. You open a PR, get review, merge to main.
4. CI on main runs. Compares `0.1.8` against npm → newer → publishes.
5. Tag `v0.1.8` is created. GitHub release "v0.1.8" is opened with notes.
6. `npx light-mem@0.1.8` works for users immediately.

If you merge a docs-only change to main and the pre-commit hook was disabled
for that commit, `package.json` won't move and CI will skip the publish. The
"skip if version already published" step makes this safe.