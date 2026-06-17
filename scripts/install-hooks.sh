#!/usr/bin/env bash
#
# Install light-mem's git hooks.
#
# Idempotent: re-running this overwrites the existing pre-commit hook.
# Use `--uninstall` to remove.
#
# Hooks installed:
#   .git/hooks/pre-commit
#     - Runs scripts/bump-version.cjs (auto-bumps package.json + marketplace
#       manifest, re-stages the bump into the same commit, no second commit).
#     - Aborts the commit if package.json is unparseable.
#
# What the hook does NOT do:
#   - It does not push, tag, or publish. Those happen in CI on main.
#   - It does not run typecheck/build on every commit — those are CI's job.
#     Keeping the hook fast (~50ms) means it doesn't get disabled out of
#     frustration by developers committing typo fixes.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
PRE_COMMIT="$HOOKS_DIR/pre-commit"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$PRE_COMMIT" ] && grep -q "light-mem-bump-version" "$PRE_COMMIT"; then
    rm "$PRE_COMMIT"
    echo "Removed pre-commit hook."
  else
    echo "No light-mem pre-commit hook to remove."
  fi
  exit 0
fi

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Not a git checkout (no .git/hooks). Aborting." >&2
  exit 1
fi

if [ -f "$PRE_COMMIT" ] && ! grep -q "light-mem-bump-version" "$PRE_COMMIT"; then
  echo "A pre-commit hook already exists that isn't ours. Backing up to pre-commit.bak."
  mv "$PRE_COMMIT" "$PRE_COMMIT.bak"
fi

cat > "$PRE_COMMIT" <<'HOOK'
#!/usr/bin/env bash
# light-mem-bump-version
# Auto-bumps package.json + .claude-plugin/marketplace.json on every commit.
# Idempotent: skipped if package.json already differs from HEAD.
set -euo pipefail
node "$(git rev-parse --show-toplevel)/scripts/bump-version.cjs"
HOOK

chmod +x "$PRE_COMMIT"
echo "Installed pre-commit hook at $PRE_COMMIT"
echo "Re-run with --uninstall to remove."