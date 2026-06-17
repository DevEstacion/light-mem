# Migrating from claude-mem to light-mem

Runbook for users with an existing `claude-mem` (thedotmack/claude-mem v13.x)
SQLite database who want to move to `light-mem` without losing history.

light-mem is a stripped-down Node-only fork of claude-mem. Both use the same
SQLite schema for the four core tables (`sdk_sessions`, `user_prompts`,
`observations`, `session_summaries`), so migration is a row-by-row copy via
the existing `/api/import` endpoint.

Tested on `light-mem` v0.1.1 against a `claude-mem` v13.6.x install with 128
sessions and 289 user prompts.

## What moves

| Data | Source | Destination | Notes |
|------|--------|-------------|-------|
| `sdk_sessions` | `~/.claude-mem/claude-mem.db` | `~/.light-mem/light-mem.db` (via `/api/import`) | All columns including `platform_source` (since v0.1.1) |
| `user_prompts` | `~/.claude-mem/claude-mem.db` | `~/.light-mem/light-mem.db` | All columns |
| `observations` | `~/.claude-mem/claude-mem.db` | `~/.light-mem/light-mem.db` | Embedded via potion (model2vec) on import; replaces ChromaDB vectors |
| `session_summaries` | `~/.claude-mem/claude-mem.db` | `~/.light-mem/light-mem.db` | All columns |
| ChromaDB vectors | `~/.claude-mem/chroma/` | rebuilt from observations | One-shot re-embed via potion |
| Settings | `~/.claude-mem/settings.json` | `~/.light-mem/settings.json` | Manual copy or fresh start with defaults |
| Worker PID | `~/.claude-mem/worker.pid` | `~/.light-mem/worker.pid` | Stale — discard |

## What does NOT move

- **Per-session CLAUDE auth metadata** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY` and
  related env entries) — these live in `~/.claude/settings.json`, not the DB.
- **OAuth tokens** (`~/.claude-mem/oauth-*`) — re-authenticate via Claude
  Code on first light-mem run.
- **Worker port assignment conflict** — see step 3.

## Prerequisites

- Node ≥24 on `PATH` (`node --version` should print ≥24.0.0)
- The `light-mem` repo cloned and built (`npm install && npm run build`)
- A read-only copy of `~/.claude-mem/claude-mem.db`

## Step 1: Snapshot the source DB

Do this first so you can re-run the test if anything goes wrong.

```bash
mkdir -p /tmp/migration-test
cp -p ~/.claude-mem/claude-mem.db     /tmp/migration-test/source.db
cp -p ~/.claude-mem/claude-mem.db-shm /tmp/migration-test/source.db-shm 2>/dev/null || true
cp -p ~/.claude-mem/claude-mem.db-wal /tmp/migration-test/source.db-wal 2>/dev/null || true

sqlite3 /tmp/migration-test/source.db \
  "SELECT 'sessions', COUNT(*) FROM sdk_sessions
   UNION ALL SELECT 'prompts', COUNT(*) FROM user_prompts
   UNION ALL SELECT 'observations', COUNT(*) FROM observations
   UNION ALL SELECT 'summaries', COUNT(*) FROM session_summaries;"
```

Note the row counts. The migration should reproduce them exactly.

## Step 2: Stop the live claude-mem worker

```bash
# If running via the npm/npx install
kill "$(cat ~/.claude-mem/worker.pid)" 2>/dev/null || true
pkill -f chroma-mcp 2>/dev/null || true

# If running via the Claude Code plugin marketplace
pkill -f "claude-mem/scripts/worker-service.cjs" 2>/dev/null || true
pkill -f chroma-mcp 2>/dev/null || true

# Verify
ps aux | grep -E "(claude-mem|chroma-mcp)" | grep -v grep
```

You should see no output (other than the grep itself, suppressed).

## Step 3: Pick a non-conflicting worker port

light-mem's default port is `37700 + (uid % 100)`. claude-mem's was either a
fixed port (`37777`) or the same per-uid formula depending on version. **If
your live claude-mem is on your derived port, light-mem will collide.**

Override on the worker command line:

```bash
LIGHT_MEM_WORKER_PORT=37888
```

Pick any port not in use. Verify with `ss -lntp | grep 37888` (empty is good).

## Step 4: Create an isolated light-mem data dir for the test run

Do NOT point this at `~/.light-mem/` yet. Use a temp dir so you can verify
the migration before replacing your real data.

```bash
mkdir -p /tmp/migration-test/data
umask 077
touch /tmp/migration-test/data/settings.json
chmod 600 /tmp/migration-test/data/settings.json
```

## Step 5: Start a light-mem worker in the test data dir

```bash
LIGHT_MEM_DATA_DIR=/tmp/migration-test/data \
LIGHT_MEM_WORKER_PORT=37888 \
LIGHT_MEM_WORKER_HOST=127.0.0.1 \
node /path/to/light-mem/plugin/scripts/worker-service.cjs start
```

Wait for `{"status":"ready"}` on stdout. Then:

```bash
curl -s http://127.0.0.1:37888/health
# Expected: {"status":"ok","timestamp":...}
```

## Step 6: Run the migration bridge

Save this as `/tmp/migration-test/migrate.js`:

```javascript
const fs = require('fs');
const { execSync } = require('child_process');

const SOURCE_DB = process.env.SOURCE_DB || '/tmp/migration-test/source.db';
const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:37888';

function sqliteJson(query) {
  const out = execSync(
    `sqlite3 -json '${SOURCE_DB}' "${query.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  ).trim();
  return out ? JSON.parse(out) : [];
}

(async () => {
  const sessions = sqliteJson(`
    SELECT content_session_id, memory_session_id, project, user_prompt,
           started_at, started_at_epoch, completed_at, completed_at_epoch,
           status, platform_source
    FROM sdk_sessions
  `);
  const summaries = sqliteJson(`
    SELECT memory_session_id, project, request, investigated, learned,
           completed, next_steps, files_read, files_edited, notes,
           prompt_number, discovery_tokens, created_at, created_at_epoch
    FROM session_summaries
  `);
  const observations = sqliteJson(`
    SELECT memory_session_id, project, text, type, title, subtitle,
           facts, narrative, concepts, files_read, files_modified,
           prompt_number, discovery_tokens, created_at, created_at_epoch,
           agent_type, agent_id
    FROM observations
  `);
  const prompts = sqliteJson(`
    SELECT content_session_id, prompt_number, prompt_text,
           created_at, created_at_epoch
    FROM user_prompts
  `);

  console.log(`Reading from ${SOURCE_DB}…`);
  console.log(`  sessions:     ${sessions.length}`);
  console.log(`  summaries:    ${summaries.length}`);
  console.log(`  observations: ${observations.length}`);
  console.log(`  prompts:      ${prompts.length}`);

  const res = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions, summaries, observations, prompts }),
  });
  console.log('Import:', await res.json());
})().catch(err => { console.error(err); process.exit(1); });
```

Run it:

```bash
node /tmp/migration-test/migrate.js
```

Expected output (counts will match your source DB):

```
Reading from /tmp/migration-test/source.db…
  sessions:     128
  summaries:    0
  observations: 0
  prompts:      289
Import: {
  "success": true,
  "stats": {
    "sessionsImported": 128, "sessionsSkipped": 0,
    "summariesImported": 0, "summariesSkipped": 0,
    "observationsImported": 0, "observationsSkipped": 0,
    "promptsImported": 289, "promptsSkipped": 0
  }
}
```

**Zero skipped is the success criterion.** If anything was skipped, those
rows already exist in the destination (probably from a prior aborted run);
drop the destination DB before re-running.

## Step 7: Verify migrated data is queryable

```bash
# Stats — should show your session count
curl -s http://127.0.0.1:37888/api/stats | python3 -m json.tool

# Projects — should list all your migrated project names
curl -s http://127.0.0.1:37888/api/projects | python3 -m json.tool

# Prompt search — pick a real string from a prompt you remember
curl -s "http://127.0.0.1:37888/api/search/prompts?query=YOUR_QUERY&limit=5" \
  | python3 -m json.tool
```

If you have observations, also try:

```bash
curl -s "http://127.0.0.1:37888/api/search?query=YOUR_QUERY&limit=5" \
  | python3 -m json.tool
```

## Step 8: Stop the test worker

```bash
LIGHT_MEM_DATA_DIR=/tmp/migration-test/data \
LIGHT_MEM_WORKER_PORT=37888 \
node /path/to/light-mem/plugin/scripts/worker-service.cjs stop
```

## Step 9: Promote to the live data dir

Once you've confirmed everything migrated correctly:

```bash
mkdir -p ~/.light-mem
mv /tmp/migration-test/data/light-mem.db ~/.light-mem/light-mem.db

node /path/to/light-mem/plugin/scripts/worker-service.cjs start
```

If you don't have a custom settings file, the worker will create one with
defaults on first start.

## Step 10: Install the OpenCode plugin

```bash
node /path/to/light-mem/dist/npx-cli/index.js install --ide opencode
```

This copies `plugin/integrations/opencode/light-mem.js` to
`~/.config/opencode/plugins/light-mem.js` and adds the plugin reference to
`~/.config/opencode/opencode.json`.

## Step 11: Tear down claude-mem

Only after you've confirmed light-mem is working end-to-end:

```bash
# Remove the marketplace install (if present)
rm -rf ~/.claude/plugins/cache/thedotmack
rm -rf ~/.claude/plugins/marketplaces/thedotmack

# Remove the npm/npx install remnants
rm -rf ~/.npm/_npx/*/node_modules/claude-mem

# Optionally keep the data dir for archival, or delete it
rm -rf ~/.claude-mem
```

## Smoke test (end-to-end)

After step 10, in OpenCode:

1. Trigger any tool call (read a file, run a command).
2. Check `~/.light-mem/light-mem.db` grew (a new row in `sdk_sessions` or
   `observations`).
3. Run `npx light-mem search <term>` from your shell — should return results
   from migrated data.
4. Open a new OpenCode session — the `AGENTS.md` (or context block) should
   include a digest of past observations if any exist.

## Troubleshooting

**`Error: connect ECONNREFUSED 127.0.0.1:37888`**

Worker isn't running. Re-run step 5 and verify `{"status":"ready"}` appeared.

**`sessionsImported: 128, sessionsSkipped: 0, promptsImported: 0,
promptsSkipped: 289`**

You're re-running on a destination that already has the data. Drop the
destination DB and re-run:

```bash
LIGHT_MEM_DATA_DIR=/tmp/migration-test/data \
LIGHT_MEM_WORKER_PORT=37888 \
node /path/to/light-mem/plugin/scripts/worker-service.cjs stop
rm /tmp/migration-test/data/light-mem.db
LIGHT_MEM_DATA_DIR=/tmp/migration-test/data \
LIGHT_MEM_WORKER_PORT=37888 \
node /path/to/light-mem/plugin/scripts/worker-service.cjs start
node /tmp/migration-test/migrate.js
```

**Port collision: `EADDRINUSE`**

Another process (probably the live claude-mem worker) is on the port you
chose. Pick a different `LIGHT_MEM_WORKER_PORT`.

**Migration imported fine but search returns "No results found"**

You have no observations (this is normal for installs that capture prompts
but not observations). The default observation endpoint searches
observations + summaries, which are empty in this case. Use
`/api/search/prompts` to query the migrated prompt history instead.

**`FOREIGN KEY constraint failed` during import**

Source DB is corrupt or has dangling references. Re-snapshot from a fresh
checkpoint (kill claude-mem cleanly first, don't copy mid-write).

## Schema differences (v0.1.1)

light-mem's schema is a strict superset of claude-mem's, with two additions:

- `observation_feedback` table (used for tier routing; safe to leave empty)
- `observations.UNIQUE(memory_session_id, content_hash)` (replaces the legacy
  30-second dedup window; behavior identical on import)

No light-mem column is missing from the upstream schema, so all rows copy
without loss of `worker_port`, `prompt_counter`, `custom_title`, or other
sidecar fields.