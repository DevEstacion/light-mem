# ClaudeApiProvider resilience parity — design

**Date:** 2026-06-17
**Status:** approved (brainstorming) → ready for implementation plan
**Component:** `src/services/worker/ClaudeApiProvider.ts`

## Problem

`ClaudeApiProvider` (the direct Messages API compression path, selected by
`LIGHT_MEM_CLAUDE_PROVIDER=api`) is functional but materially less resilient
than the SDK-backed `ClaudeProvider`. Four gaps, in severity order:

1. **Truncation is invisible (the shape bug).** The SSE parser
   (`parseStreamingResponse`) handles only `message_start`,
   `content_block_delta`, and `error`. It never reads the `message_delta`
   event, which carries `stop_reason`. When a response hits the
   `max_tokens: 4096` ceiling, the provider returns partial text ending
   mid-tag and has no idea it was truncated — `parseAgentXml` then either
   drops the unterminated final `<observation>` or rejects the whole batch,
   silently. This is the only place the API path can corrupt the observation
   *shape* without knowing.
2. **No 429/529 backoff.** `if (!res.ok) throw` surfaces every non-2xx as a
   generic error; the batch is dropped and the next ingest hits the same
   wall. The SDK path classifies these (`classifyClaudeError`) and the quota
   guard proactively backs off.
3. **Dead-code overflow/auth checks.** Lines that test the *completion text*
   for `"prompt is too long"` / `"Invalid API key"` never fire — those
   conditions arrive as HTTP 400/401 and hit the `!res.ok` throw first.
4. **No concurrency cap.** Every session fires `fetch()` immediately; the SDK
   path gates on `waitForSlot(maxConcurrent)`.

The shape-defense layer (`processAgentResponse` → `parseAgentXml` →
classify/respawn) is already **shared** by both providers and is unchanged by
this work. This design fixes only the API path's *upstream* (the HTTP call and
the streaming parse) so it feeds that shared layer correctly and survives
transient failures.

## Core principle

Bring `ClaudeApiProvider` to SDK-level resilience **without** forcing
SDK-process abstractions onto a process-less path. Reuse what is genuinely
provider-agnostic; reimplement (lightweight) what is tied to the SDK's
subprocess model.

| Concern | Decision | Rationale |
|---|---|---|
| Error classification | **Reuse `classifyClaudeError`** (exported from `ClaudeProvider.ts`) | Already status/message-based: `429→rate_limit`, `529/5xx→transient`, `400/413→unrecoverable`, `401/403→auth_invalid`. Provider-agnostic. |
| Concurrency cap | **New lightweight `AsyncSemaphore`** | `waitForSlot` counts SDK *processes* via the process registry (`getActiveSdkCount`); the API path spawns none. A module-scoped async semaphore keyed off `LIGHT_MEM_MAX_CONCURRENT_AGENTS` mirrors the behavior. |
| Quota guard (`RateLimitStore`) | **Do not reuse** | Fed by SDK `rate_limit` system events the API path never receives. Honor the HTTP `Retry-After` header directly instead. |
| Shape defense (`processAgentResponse`) | **Already shared — no change** | Parser, invalid-output classification, and respawn machinery are provider-agnostic. |

## Components

### `parseStreamingResponse` / `parseNonStreamingResponse` → return `{ text, stopReason }`

Currently return a bare `string`. Change both to return
`{ text: string; stopReason: string | null }`.

- Streaming: add a `message_delta` case capturing `evt.delta?.stop_reason`
  (and, opportunistically, `evt.usage?.output_tokens` — not wired into
  counters in this change, see Out of scope). The parser stays a pure
  accumulator; it does not decide what truncation *means*.
- Non-streaming: read top-level `stop_reason` from the JSON body.

### `callMessagesApi` → retry + correct 4xx mapping

- Returns `{ text, stopReason }` on success.
- On `!res.ok`: construct an error carrying `status` and the parsed
  `error.type`/body, pass to `classifyClaudeError`:
  - `rate_limit` (429) → sleep `Retry-After` seconds if the header is
    present, else exponential backoff; retry (≤ 3 attempts total).
  - `transient` (529/5xx, network/`fetch` reject) → exponential backoff;
    retry (≤ 3).
  - `unrecoverable` (400/413), `auth_invalid` (401/403),
    `quota_exhausted` → throw immediately (no retry).
- Backoff: `min(2^attempt * BASE_MS, CAP_MS)`. All sleeps are abort-aware
  (reject on `session.abortController.signal.aborted`).
- Retries exhausted → throw the last classified error.
- `fetch` is injectable (parameter, defaults to the global) so tests can feed
  mock SSE streams without network.

### `AsyncSemaphore` (new, `src/services/worker/AsyncSemaphore.ts`)

~30-line async counting semaphore. `acquire(signal?)` / `release()`. Capacity
read from `LIGHT_MEM_MAX_CONCURRENT_AGENTS` (the same setting the SDK path
uses; default 2). Module-scoped singleton in `ClaudeApiProvider` so all API
sessions in the worker share one cap. FIFO waiter queue; `acquire` rejects if
the signal is already aborted or aborts while waiting.

### `startSession` loop changes

- `await sem.acquire(session.abortController.signal)` before
  `callMessagesApi`; `release()` in `finally`.
- Receive `{ text, stopReason }`.
- **Truncation branch (`stopReason === 'max_tokens'`):** persist-if-parses.
  - Log a loud WARN (prompt number + response char count) — a truncated
    batch that parses can silently drop trailing observations, so the drop
    must be visible.
  - Still call `processAgentResponse` so whatever parsed is salvaged.
  - **Do not let a truncated response reset `consecutiveInvalidOutputs`.**
    Truncation must count toward the respawn threshold even when the partial
    XML parses, so chronic truncation still escalates. (Mechanism: see Open
    item — resolved below.)
- **Normal branch:** `processAgentResponse(text, …)` exactly as today.

### Truncation counting — resolution

`consecutiveInvalidOutputs` currently lives inside `processAgentResponse` and
is incremented only when `parseAgentXml` returns `!valid`, and reset to 0 on a
valid parse. A `max_tokens` truncation can parse as valid, so on its own it
would reset the counter and never escalate.

Resolution: pass an optional `truncated` flag into `processAgentResponse`.
When `truncated` is true, the "valid parse" path does **not** reset
`consecutiveInvalidOutputs` (it leaves the counter as-is and increments toward
the existing `INVALID_OUTPUT_RESPAWN_THRESHOLD`). This is the single change to
the shared layer; it is additive (defaulted false) and the SDK path passes
nothing, preserving current behavior.

## Data flow (one observation prompt)

```
messageGenerator yields prompt
  → sem.acquire(signal)
  → callMessagesApi (retry loop: classify → backoff/Retry-After → re-fetch)
      → fetch SSE → parseStreamingResponse → { text, stopReason }
  → sem.release()   (finally)
  → stopReason === 'max_tokens'?
       yes → WARN truncation; processAgentResponse(text, {truncated:true})
              (salvage parsed; counter not reset → chronic truncation escalates)
       no  → processAgentResponse(text)   [existing shape defense unchanged]
```

## Error-handling matrix

| Condition | `classifyClaudeError` kind | Action |
|---|---|---|
| 429 | `rate_limit` | sleep `Retry-After` (or backoff), retry ≤ 3 |
| 529 / 5xx | `transient` | backoff, retry ≤ 3 |
| 400 / 413 | `unrecoverable` | throw → generator dies → next ingest respawns (transcript recovers) |
| 401 / 403 | `auth_invalid` | throw with the actionable message |
| network / `fetch` reject | `transient` | backoff, retry ≤ 3 |
| retries exhausted | — | throw last classified error |

Throwing lands in the existing `SessionRoutes.ts` generator `.catch` — no new
top-level handling. The dead-code completion-text checks (#3) are deleted; the
overflow/auth signals are now read from `res.status` in the `!res.ok` branch.

## Testing (Vitest, Node 24 — TDD, tests first)

New `tests/worker/claude-api-provider.test.ts` (provider currently has zero
tests). `callMessagesApi` takes an injectable `fetch` so tests feed mock SSE
strings without network.

1. **truncation visible** — SSE ends in `message_delta{stop_reason:"max_tokens"}`
   → parse returns `{stopReason:"max_tokens"}`; truncated-but-parsed path
   persists *and* does not reset `consecutiveInvalidOutputs`.
2. **clean stop** — `stop_reason:"end_turn"` → persists, counter reset.
3. **429 with Retry-After** → one retry after the header delay, then success.
4. **529** → backoff retry succeeds.
5. **400** → throws immediately, no retry.
6. **retries exhausted** → throws after N.
7. **non-streaming fallback** → returns `{text, stopReason}`.

New `tests/worker/async-semaphore.test.ts`:

8. **AsyncSemaphore** — cap respected, FIFO release, abort rejects a waiter.

## Files touched

- `src/services/worker/ClaudeApiProvider.ts` — parser return type, retry loop,
  4xx mapping, semaphore use, truncation branch.
- `src/services/worker/AsyncSemaphore.ts` — new.
- `src/services/worker/agents/ResponseProcessor.ts` — additive `truncated`
  flag on `processAgentResponse` (does not reset the counter when true).
- `tests/worker/claude-api-provider.test.ts` — new.
- `tests/worker/async-semaphore.test.ts` — new.
- `ClaudeProvider.ts` — unchanged (already exports `classifyClaudeError`;
  passes no `truncated` flag, preserving behavior).

## Out of scope (YAGNI)

- Token accounting on the API path (still 0 incremental; separate concern,
  acknowledged in existing code comments).
- Any change to the SDK path's behavior.
- Any change to `parseAgentXml`'s shape logic.
- Wiring `message_delta` `usage.output_tokens` into session counters (captured
  but not consumed in this change).
- Raising `max_tokens` above the current 4096 (the chosen truncation strategy
  is persist-if-parses + escalate-on-chronic, not bump-and-retry).
