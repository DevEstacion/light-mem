# Hook Node PATH Regression Fix

## Scope

Restore pure `node -e` launch commands for every host. Remove login-shell PATH bootstrap added in `30b541f`.

## Design

`buildShellCommand()` returns its existing reusable launcher result directly:

- `mcp`: `buildMcpNodeLauncher(options)`
- other hosts: `buildHookNodeLauncher(options)`

No shell syntax, `$` token, or login-shell process exists in rendered commands.

## Reason

Claude executes hooks through non-login `/bin/sh`. Escaped `\$SHELL` and `\$PATH` passed by current template remain literal, set an invalid PATH, then bare `node` cannot start. The same text is also placed in MCP JavaScript arguments, where `export` is invalid syntax. Grok requires no `$` tokens.

## Test

Keep existing generated-artifact tests asserting every hook starts `node -e` and contains no `$`. Add a focused template test covering direct launcher output for hook and MCP hosts, so bootstrap injection cannot return.

## Non-goals

No absolute Node path discovery, shell-specific fallback, generated-file edits, dependency change, or broad refactor.
