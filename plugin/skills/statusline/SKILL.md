---
name: statusline
description: Add a persistent "📚 light-mem: N obs" segment to the Claude Code status line so memory activity is always visible. Use when the user asks to "show light-mem in the status line", "add light-mem to my statusline", or wants an always-on indicator that light-mem is running.
---

# Add light-mem to the Claude Code status line

light-mem's hooks already run on every tool call, but the `statusMessage` spinners
they show are transient (~300ms) and easy to miss. This skill adds a **persistent**
`📚 light-mem: N obs` segment to the user's status line, scoped to the current project.

## Operating rule: propose, then confirm

NEVER write to the user's statusline script or `settings.json` before showing the
exact change and getting explicit approval. Inspect first, propose a concrete diff or
snippet, wait for "yes", then apply and verify.

## The helper

light-mem ships `scripts/statusline-counts.js` inside the installed plugin. It:
- takes the project directory as **argv[2]** (NOT stdin),
- prints one line of **JSON**: `{"observations":N,"prompts":N,"project":"name"}`,
- degrades to zero counts on any error (never throws).

Claude Code's statusLine contract is different: it sends a JSON **payload on stdin**
(with `.workspace.current_dir`, `.model.display_name`, etc.) and expects the first
line of **stdout** to be the literal status-line text. So the helper is never wired as
CC's statusLine command directly — it is always called *from within* a wrapper/script
that reads stdin, calls the helper with the cwd, and formats plain text.

Resolve the newest installed plugin version dynamically so the segment survives plugin
updates (do not hardcode a version):

```bash
ls -dt "$HOME/.claude/plugins/cache/light-mem/light-mem"/[0-9]*/ 2>/dev/null | head -1
```

## Workflow

### 1. Detect the current statusLine

Check, in order, `~/.claude/settings.json`, `~/.claude/settings.local.json`, then the
project `.claude/settings.json`. Read the `statusLine` field:

```bash
node -e "const j=require(process.argv[1]);console.log(JSON.stringify(j.statusLine||null))" ~/.claude/settings.json
```

This yields one of three cases.

### 2a. No statusLine configured (greenfield)

Propose creating `~/.claude/statusline/light-mem-statusline.sh` and pointing
`settings.json` at it. The script reads CC's stdin, calls the helper, emits plain text:

```bash
#!/usr/bin/env bash
input=$(cat)
dir=$(echo "$input" | jq -r '.workspace.current_dir // ""')
seg=""
root=$(ls -dt "$HOME/.claude/plugins/cache/light-mem/light-mem"/[0-9]*/ 2>/dev/null | head -1)
if [[ -n "$root" && -f "${root}scripts/statusline-counts.js" ]]; then
  json=$(node "${root}scripts/statusline-counts.js" "$dir" 2>/dev/null)
  [[ -n "$json" ]] && seg="📚 light-mem: $(echo "$json" | jq -r '.observations // 0') obs"
fi
echo "$seg"
```

Then the settings change:
```json
{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline/light-mem-statusline.sh" } }
```

(If `jq` is unavailable, parse the JSON with `node -e` instead — confirm `jq` exists
first with `command -v jq`.)

### 2b. Existing custom command script (e.g. `statusline.sh`)

Read the user's script. Find where it builds its output line(s). Propose a **surgical,
additive** insertion — never replace the file. Compute the segment using the cwd the
script already extracts from stdin, then append it to the line the user prefers:

```bash
# light-mem segment (additive; silent if light-mem absent)
lm_seg=""
lm_root=$(ls -dt "$HOME/.claude/plugins/cache/light-mem/light-mem"/[0-9]*/ 2>/dev/null | head -1)
if [[ -n "$lm_root" && -f "${lm_root}scripts/statusline-counts.js" ]]; then
  lm_json=$(node "${lm_root}scripts/statusline-counts.js" "$dir" 2>/dev/null)
  [[ -n "$lm_json" ]] && lm_seg="📚 light-mem: $(echo "$lm_json" | jq -r '.observations // 0') obs"
fi
# then: [[ -n "$lm_seg" ]] && line="$line │ $lm_seg"
```

Match the script's existing variable names, separators, and glyph style. Pick a glyph
that does not collide with existing segments (the brain 🧠 is often already used for
context %; 📚 is a safe default).

### 2c. Existing inline command or unparseable setup

Do not attempt an automatic merge. Print the segment snippet and tell the user where to
splice it, then stop.

### 3. Verify before declaring done

Run the script with a realistic CC stdin payload and confirm the segment appears AND
that it degrades silently when light-mem is absent:

```bash
echo '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"display_name":"Claude"},"version":"?","context_window":{"used_percentage":0}}' | bash <script>
```

The segment is project-scoped: counts reflect whatever `current_dir` is passed, so it
doubles as an "is light-mem alive in *this* project" signal. Confirm the rest of the
user's status line is unchanged.

## Keep it lean

Show observations only by default (`📚 light-mem: N obs`). The helper also returns a
`prompts` count — add `· N prompts` only if the user explicitly asks.
