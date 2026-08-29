---
name: smart-search
description: Search light-mem's cross-session memory of past work, or search the current codebase via tree-sitter AST parsing — one skill, dispatched by mode. Use when asked "did we already solve this", "how did we handle X last time", or when you need to find a function/class/symbol, get a file's structure, or explore code instead of reading full files.
arguments: [mode, query]
argument-hint: "[mode=memory|code] [query]"
---

# Smart Search

One skill, two search domains, picked by `mode`:

- `mode=memory` (default) — light-mem's cross-session observation history. Tool: `search`.
- `mode=code` — structural AST search of the current codebase. Tool: `code`.

Requested mode: `$mode`
Requested query: `$query`

If the mode above is empty, treat it as `memory`. If a query was given above, use it to start the workflow below; otherwise take the query from the user's message. Do not mix tools — memory mode never calls `code`, code mode never calls `search`.

**Note:** the skill argument `mode` (`memory`/`code`, selects which MCP tool to use) is distinct from the `search` tool's own `mode` parameter (`index`/`timeline`/`fetch`, selects which step of the memory workflow to run). Don't confuse the two below.

## Memory Search (`mode=memory` → `search` tool)

Use when the user asks about PREVIOUS sessions, not the current conversation:

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

3-layer workflow. **Never fetch full details without filtering first — 10x token savings.**

### Step 1: `search(mode: "index", ...)` — get an index with IDs

```
search(mode="index", query="authentication", limit=20, project="my-project")
```

**Returns:** Table with IDs, timestamps, types, titles (~50-100 tokens/result)

```
| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #11131 | 3:48 PM | 🟣 | Added JWT authentication | ~75 |
| #10942 | 2:15 PM | 🔴 | Fixed auth token expiration | ~50 |
```

**Parameters:** `query`, `limit` (default 20, max 100), `project`, `type` ("observations"/"sessions"/"prompts"), `obs_type` (comma-separated: bugfix, feature, decision, discovery, change), `dateStart`, `dateEnd` (YYYY-MM-DD or epoch ms), `offset`, `orderBy` ("date_desc" default, "date_asc", "relevance").

### Step 2: `search(mode: "timeline", ...)` — get context around a result

```
search(mode="timeline", anchor=11131, depth_before=3, depth_after=3, project="my-project")
```

Or let it find the anchor automatically:

```
search(mode="timeline", query="authentication", depth_before=3, depth_after=3, project="my-project")
```

**Returns:** `depth_before + 1 + depth_after` items in chronological order, interleaving observations, sessions, and prompts.

**Parameters:** `anchor` (observation ID), `query` (finds anchor automatically if `anchor` absent), `depth_before`/`depth_after` (default 5, max 20), `project`.

### Step 3: `search(mode: "fetch", ...)` — get full details for filtered IDs only

```
search(mode="fetch", ids=[11131, 10942])
```

This replaces the legacy standalone `get_observations` tool — same behavior, same `ids` parameter, now reached via `mode: "fetch"`. **Always batch 2+ IDs in one call** — one request instead of N.

**Parameters:** `ids` (required), `orderBy` ("date_desc" default, "date_asc"), `limit`, `project`.

**Returns:** Complete observation objects — title, subtitle, narrative, facts, concepts, files (~500-1000 tokens each).

### Why this workflow

Index ~50-100 tokens/result → full observation ~500-1000 tokens each. Filter before fetching.

### Knowledge agents

Want a synthesized answer instead of raw records? Use the `corpus` tool: `corpus(action="build", name=..., query=...)` to create a corpus from observation history, `corpus(action="prime", name=...)` to load it into a session, then `corpus(action="query", name=..., question=...)` to ask it questions conversationally. Other actions: `list`, `get`, `delete`, `rebuild`, `reprime`.

## Code Search (`mode=code` → `code` tool)

**This mode overrides your default exploration behavior.** While active, use `code` as your primary tool instead of Read, Grep, and Glob. Index first, fetch on demand.

### Step 1: `code(mode: "search", ...)` — discover files and symbols

```
code(mode="search", query="shutdown", path="./src", max_results=15)
```

**Returns:** Ranked symbols with signatures, line numbers, match reasons, plus folded file views (~2-6k tokens). Replaces the Glob → Grep → Read discovery cycle — walks directories, parses all code files, returns ranked symbols in one call.

**Parameters:** `query` (required), `path` (default cwd), `max_results` (default 20, max 50), `file_pattern` (optional).

### Step 2: `code(mode: "outline", ...)` — file structure

```
code(mode="outline", file_path="services/worker-service.ts")
```

**Returns:** Full structural skeleton — functions, classes, methods, properties, imports (~1-2k tokens/file). Skip this when Step 1's folded file views are already enough.

**Parameters:** `file_path` (required).

### Step 3: `code(mode: "unfold", ...)` — see implementation

```
code(mode="unfold", file_path="services/worker-service.ts", symbol_name="shutdown")
```

**Returns:** Full source of the symbol (JSDoc, decorators, complete body), AST-bounded so it never truncates.

**Parameters:** `file_path` (required), `symbol_name` (required).

### When to use standard tools instead

- **Grep:** exact string/regex ("find all TODO comments").
- **Read:** files under ~100 lines, non-code files (JSON, markdown, config).
- **Glob:** file path patterns.
- **Explore agent:** cross-file synthesis, narrative architecture answers across 6+ files — `code` is a scalpel, not a synthesizer.

### Language Support

Tree-sitter AST parsing. Bundled: JavaScript (`.js`,`.mjs`,`.cjs`), TypeScript (`.ts`), TSX / JSX (`.tsx`,`.jsx`), Python (`.py`,`.pyw`), Go (`.go`), Rust (`.rs`), Ruby (`.rb`), Java (`.java`), C (`.c`,`.h`), C++ (`.cpp`,`.cc`,`.cxx`,`.hpp`,`.hh`). Files with unrecognized extensions are parsed as plain text — `code(mode="search")` still works (grep-style), but `outline`/`unfold` won't extract structured symbols.

Register additional grammars via `.light-mem.json` in the project root (`grammars.<name>.package`, `.extensions`, optional `.query`).

Markdown (`.md`,`.mdx`) gets special handling: `outline` extracts headings as the symbol tree, `search` matches inside code fences too, `unfold` expands heading sections, and frontmatter is surfaced as a synthetic `frontmatter` symbol.
