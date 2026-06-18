# OpenCode integration

light-mem ships an OpenCode plugin that captures tool usage and session
events into the same SQLite database the Claude Code hooks write to. The
install is layered so the plugin survives any way you launch OpenCode:
plain binary, `ocx`-managed profiles, or anything that sets
`OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT`.

## Install

```bash
npx -y light-mem@latest install --ide opencode
npx -y light-mem@latest start          # the worker (separate process)
```

Restart OpenCode after install. Hooks fire on the next tool call.

The installer runs three independent load paths in order. Any one of
them surviving is enough for OpenCode to pick the plugin up.

| # | Where written                                          | Why it works                                              |
|---|--------------------------------------------------------|-----------------------------------------------------------|
| 1 | `~/.config/opencode/plugins/light-mem.js`              | OpenCode auto-loads `plugins/*.{ts,js}` per its docs.    |
| 2 | `"light-mem"` entry in `~/.config/opencode/opencode.json` (or `.jsonc`) `plugin` array | The npm package name is the canonical shape of the array. OpenCode resolves it via its npm cache. |
| 3 | Mirror of #1 into `$OPENCODE_CONFIG_DIR/plugins/` if set | Required for `ocx`-style setups that regenerate the merged dir on each OpenCode launch. |

If `opencode` is on `PATH`, step 2 runs as
`opencode plugin install light-mem --global` (the official install
path). If that fails, the installer writes the config entry itself.

For users whose toolchain sets `OPENCODE_CONFIG_CONTENT` (e.g. `ocx`),
step 2 is the load-bearing one: OpenCode's config loader merges the
global config into the active config rather than replacing it, so a
`"light-mem"` entry in `~/.config/opencode/opencode.json` reaches the
plugin array even when `OPENCODE_CONFIG_CONTENT` is shadowing other
fields.

## Verification

```bash
# 1. Worker is up
curl -sf http://127.0.0.1:37700/health

# 2. Plugin is loaded
ls -la ~/.config/opencode/plugins/light-mem.js
grep '"light-mem"' ~/.config/opencode/opencode.json

# 3. Trigger a tool call in OpenCode, then check the DB
sqlite3 ~/.light-mem/light-mem.db \
  "SELECT id, project, created_at FROM observations ORDER BY id DESC LIMIT 3;"
```

Hook fires look like this in `~/.light-mem/logs/*.log`:

```
[HOOK  ] [session-129] INIT_COMPLETE | sessionDbId=129 | promptNumber=10 | project=light-mem
[HOOK  ] → PostToolUse: Bash(...)
[QUEUE ] [session-129] ENQUEUED | type=observation
[DB    ] [session-129] STORED | obsIds=[77]
```

## Uninstall

```bash
npx -y light-mem@latest uninstall --ide opencode
# then restart OpenCode
```

Cleans up:

- `~/.config/opencode/plugins/light-mem.js`
- `light-mem` from the global `opencode.json` / `opencode.jsonc` `plugin` array
- Bundle copy under `$OPENCODE_CONFIG_DIR/plugins/`
- Light-mem's `AGENTS.md` context block (if present)

## Architecture

The OpenCode plugin lives at `src/integrations/opencode-plugin/`. The
build (`npm run build`) bundles it via esbuild to
`dist/opencode-plugin/index.js` and copies a snapshot into
`plugin/integrations/opencode/light-mem.js`. The npm package ships
both paths so users can load it either as a local file or as an npm
plugin.

Hooks subscribed (see OpenCode plugin docs for the full list):

- `tool.execute.after` — captures every Read / Edit / Bash / Glob / Grep / WebFetch / etc.
- `chat.message` — captures assistant messages (assistant_message observation type)
- `experimental.session.compacting` — re-summarises on context compaction
- `event.session.idle` / `event.session.deleted` — session lifecycle
- `tool.light_mem_search` — exposes the memory DB as a queryable tool inside OpenCode

The plugin POSTs observations to `http://127.0.0.1:$LIGHT_MEM_WORKER_PORT/api/sessions/observations`
asynchronously. The worker normalises the event, queues an observation
generation request to the Claude provider (SDK or direct Messages API),
and writes the result to SQLite. Search is exposed through MCP at the
same address.

## Caveats

- **OPENCODE_CONFIG_CONTENT users**: the installer cannot edit an env
  var. The global config's plugin entry still loads (OpenCode merges),
  but if your tooling wipes the global config on each launch, the
  npm-side install (`opencode plugin install light-mem --global`)
  won't stick either. The local-file path (#1) is the durable one.
- **OCX profile purge**: `ocx oc` regenerates the merged config dir on
  every OpenCode launch. Without step #3, the bundle inside
  `$OPENCODE_CONFIG_DIR/plugins/` gets wiped each restart.
- **Node ≥24** for the worker (uses built-in `node:sqlite`).
- **Restart after install.** OpenCode reads plugin dirs and config at
  startup; a running TUI will not pick up changes mid-session.
