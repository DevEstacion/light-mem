# Claude providers

light-mem compresses tool-call events into structured `<observation>` records using
a Claude model. There are two providers, controlled by `LIGHT_MEM_CLAUDE_PROVIDER`
in `~/.light-mem/settings.json`:

| Setting            | Provider             | Requires `claude` binary? | API surface                       |
|--------------------|----------------------|----------------------------|-----------------------------------|
| `sdk` (default)    | `ClaudeProvider`     | yes                        | Claude Agent SDK subprocess        |
| `api`              | `ClaudeApiProvider`  | no                         | Direct HTTP POST to `/v1/messages`|

`auto` is also accepted: the worker picks `api` if the `claude` binary is not on PATH,
otherwise `sdk`. The default of `sdk` is preserved for backward compatibility — users
with a working Claude Code install continue to use the SDK path.

## ClaudeProvider (SDK)

`src/services/worker/ClaudeProvider.ts`. Spawns the `claude` binary via
`@anthropic-ai/claude-agent-sdk`, which handles:

- Multi-turn conversation state (init prompt + follow-up observation prompts share
  the same session).
- Tool use from the agent side (the agent can call Bash/Read during compression).
- Quota tracking via the SDK's `system` events with `rate_limit` subtype.

The SDK reads `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` from the isolated env
(`buildIsolatedEnvWithFreshOAuth`), so the same auth configuration works.

**When to use:** you already have Claude Code installed and want full SDK features
(multi-turn, tool use, quota tracking).

**When NOT to use:** Claude Code is not installed (e.g. you only have OpenCode, or you
want a slimmer install). The SDK subprocess fails with "Claude executable not found"
and observations never get written.

## ClaudeApiProvider (direct Messages API)

`src/services/worker/ClaudeApiProvider.ts`. POSTs to `${ANTHROPIC_BASE_URL}/v1/messages`
with `stream: true`, accumulates the SSE `content_block_delta` events into a single
text response, and calls the same `processAgentResponse()` the SDK path uses.

Differences vs SDK path:

- No `claude` binary required. Works on hosts with only OpenCode.
- No multi-turn conversation state. Each observation prompt is a fresh single-turn
  request. The schema is inlined in every prompt (`buildObservationPrompt` embeds
  the canonical `<observation>` template) so the model can produce valid XML without
  prior context.
- No agent-side tool use. The agent can't call Bash/Read during compression. For
  observation compression this is fine — the prompt is "extract structure from
  this text," not "go investigate the repo."
- `memory_session_id` is synthesized from `content_session_id` (the editor's per-
  session id, already unique). The SDK path captures the SDK-issued session id
  from the first response; the API path has no SDK to issue one.

**When to use:** Claude Code is not installed. The system is on a Minimax gateway,
AWS Bedrock, or any other Anthropic-compatible endpoint. You want a Node-only install
with no extra binaries.

## Auth matrix

All three Claude auth paths work with either provider. The provider only changes
how the request is made; auth is determined by env vars.

| Auth method                        | `ANTHROPIC_BASE_URL`              | `ANTHROPIC_AUTH_TOKEN` source       |
|------------------------------------|------------------------------------|-------------------------------------|
| Direct Anthropic API                | (unset, defaults to api.anthropic.com) | `ANTHROPIC_API_KEY`            |
| AWS Bedrock                         | (unset, set `CLAUDE_CODE_USE_BEDROCK=1`) | AWS IAM credentials           |
| Third-party gateway (Minimax, 9router, etc.) | The gateway's base URL | The gateway's auth token    |
| Claude Code OAuth (subscription)    | (unset)                            | OAuth keychain (built-in)          |

The minimax.com integration is documented in their platform guide and works
identically: set `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`,
`ANTHROPIC_AUTH_TOKEN=<minimax key>`, `LIGHT_MEM_CLAUDE_PROVIDER=api`, and the
`haiku`/`sonnet`/`opus` tier aliases all map to `MiniMax-M3` server-side.

## Switching providers

Edit `~/.light-mem/settings.json`:

```json
{
  "LIGHT_MEM_CLAUDE_PROVIDER": "api",
  "LIGHT_MEM_CLAUDE_AUTH_METHOD": "gateway"
}
```

Restart the worker:

```bash
npx light-mem restart
```

The new provider takes effect on the next observation. Existing observations and
their embeddings are unchanged — provider is a session-time choice, not a data
format.

## Failure modes

| Symptom                                       | Cause                                       | Fix                                       |
|-----------------------------------------------|---------------------------------------------|-------------------------------------------|
| `Claude executable not found`                | `provider=sdk`, no `claude` binary          | `LIGHT_MEM_CLAUDE_PROVIDER=api`            |
| `Provider not found` 401 from base URL        | `ANTHROPIC_BASE_URL` typo or stale token   | Re-issue token, verify base URL            |
| `Context window exceeded`                     | Tool output truncated the wrong field       | Already handled by `truncateObservationField` |
| `Parser rejected observation` (log: "non-XML") | Model ignored schema, returned raw text    | Update to ≥0.1.4 (schema is inlined)       |