
/**
 * Tests for ClaudeApiProvider — inject mock fetch so no real HTTP is issued.
 * Backoff delays are shrunk via BASE_MS injection so the suite stays fast.
 */
import { describe, it, expect, vi } from 'vitest';

// ModeManager mock must be hoisted before any source import that touches it.
vi.mock('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'code' }, { id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

vi.mock('../../src/shared/worker-utils.js', () => ({ getWorkerPort: () => 37777 }));
vi.mock('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

// --- helpers to build fake SSE streams ---

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(ev));
      }
      controller.close();
    },
  });
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeStreamingResponse(events: string[], status = 200): Response {
  return new Response(sseStream(events), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Typical SSE sequence for a clean end_turn
function endTurnEvents(text: string): string[] {
  return [
    sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ];
}

// SSE sequence that ends with max_tokens
function maxTokensEvents(text: string): string[] {
  return [
    sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ];
}

import { ClaudeApiProviderTestHarness } from '../../src/services/worker/ClaudeApiProvider.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';

// --- base args ---
const BASE_ARGS = {
  baseUrl: 'https://api.anthropic.com',
  authToken: 'sk-test',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: '<test>hello</test>',
  maxTokens: 4096,
  // Fast backoff for tests
  BASE_MS: 5,
  CAP_MS: 20,
};

describe('ClaudeApiProviderTestHarness.callMessagesApi', () => {
  it('(1) parses stopReason "max_tokens" from message_delta SSE event', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeStreamingResponse(maxTokensEvents('<observation>partial'))
    );

    const harness = new ClaudeApiProviderTestHarness();
    const result = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    );

    expect(result.stopReason).toBe('max_tokens');
    expect(result.text).toContain('<observation>partial');
  });

  it('(2) parses stopReason "end_turn" from a clean message_delta event', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeStreamingResponse(endTurnEvents('<observation>done</observation>'))
    );

    const harness = new ClaudeApiProviderTestHarness();
    const result = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toContain('<observation>done</observation>');
  });

  it('(3) retries on 429 and HONORS the Retry-After header delay, then succeeds', async () => {
    // Retry-After: 0.1s. Assert the call actually waited ~that long — proving
    // the header is honored rather than ignored in favor of the (tiny, 5ms)
    // exponential backoff. A bug that dropped Retry-After would return in ~5ms.
    const retryAfterRes = new Response(
      JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limited' } }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0.1' },
      }
    );
    const successRes = makeStreamingResponse(endTurnEvents('<observation>ok</observation>'));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(retryAfterRes)
      .mockResolvedValueOnce(successRes);

    const harness = new ClaudeApiProviderTestHarness();
    const start = Date.now();
    const result = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    );
    const elapsed = Date.now() - start;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('end_turn');
    // ~100ms from the header, not ~5ms from BASE_MS backoff. Lower bound only
    // (avoid upper-bound flakiness on a busy CI box).
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('(4) retries on 529 with backoff then succeeds', async () => {
    const overloadedRes = new Response(
      JSON.stringify({ error: { type: 'overloaded_error', message: 'overloaded' } }),
      { status: 529, headers: { 'content-type': 'application/json' } }
    );
    const successRes = makeStreamingResponse(endTurnEvents('<observation>ok</observation>'));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(overloadedRes)
      .mockResolvedValueOnce(successRes);

    const harness = new ClaudeApiProviderTestHarness();
    const result = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.text).toBeTruthy();
    expect(result.stopReason).toBe('end_turn');
  });

  it('(5) throws immediately on 400 without retrying', async () => {
    const badReqRes = new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );

    const mockFetch = vi.fn().mockResolvedValueOnce(badReqRes);

    const harness = new ClaudeApiProviderTestHarness();
    await expect(
      harness.callMessagesApi(
        { ...BASE_ARGS, signal: new AbortController().signal },
        mockFetch
      )
    ).rejects.toMatchObject({ kind: 'unrecoverable' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('(6) throws after 3 attempts when all retries exhausted on 529', async () => {
    const overloadedRes = new Response(
      JSON.stringify({ error: { type: 'overloaded_error' } }),
      { status: 529, headers: { 'content-type': 'application/json' } }
    );

    const mockFetch = vi.fn().mockResolvedValue(overloadedRes);

    const harness = new ClaudeApiProviderTestHarness();
    const err = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ClassifiedProviderError);
    expect(err.kind).toBe('transient');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('(7) handles non-streaming (JSON) response returning {text, stopReason}', async () => {
    const jsonRes = makeJsonResponse({
      content: [{ type: 'text', text: '<observation>from json</observation>' }],
      stop_reason: 'end_turn',
    });

    const mockFetch = vi.fn().mockResolvedValueOnce(jsonRes);

    const harness = new ClaudeApiProviderTestHarness();
    const result = await harness.callMessagesApi(
      { ...BASE_ARGS, signal: new AbortController().signal },
      mockFetch
    );

    expect(result.text).toBe('<observation>from json</observation>');
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('processAgentResponse truncated flag', () => {
  function makeDbManager() {
    return {
      getSessionStore: vi.fn().mockReturnValue({
        ensureMemorySessionIdRegistered: vi.fn(),
        storeObservations: vi.fn().mockReturnValue({
          observationIds: [],
          summaryId: null,
          createdAtEpoch: Date.now(),
        }),
      }),
      getChromaSync: vi.fn().mockReturnValue(null),
    } as any;
  }

  function makeSessionManager() {
    return {
      respawnPoisonedSession: vi.fn(),
      confirmClaimedMessages: vi.fn().mockResolvedValue(undefined),
      resetProcessingToPending: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  function makeSession(overrides: Record<string, unknown> = {}) {
    return {
      abortController: new AbortController(),
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session',
      lastPromptNumber: 2,
      consecutiveInvalidOutputs: 2,
      conversationHistory: [] as { role: string; content: string }[],
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingAgentId: null,
      pendingAgentType: null,
      earliestPendingTimestamp: null,
      project: '/tmp/test',
      lastSummaryStored: false,
      platformSource: 'claude',
      ...overrides,
    } as any;
  }

  // A minimal valid XML that parseAgentXml accepts
  const VALID_XML = '<observations><observation><type>code</type><title>T</title><narrative>N</narrative></observation></observations>';

  it('truncated=true below threshold: salvages (persists) AND increments the counter (not frozen)', async () => {
    // Start healthy (0). A single truncation must increment toward the
    // respawn threshold — NOT freeze at 0 — while still salvaging what parsed.
    const session = makeSession({ consecutiveInvalidOutputs: 0 });
    const dbManager = makeDbManager();
    const sessionManager = makeSessionManager();

    await processAgentResponse(
      VALID_XML, session, dbManager, sessionManager,
      undefined, 0, null, 'API', undefined, undefined,
      true  // truncated
    );

    // Counter advanced (the frozen-counter bug would leave this at 0).
    expect(session.consecutiveInvalidOutputs).toBe(1);
    // Salvage path ran — the parsed observation was persisted.
    expect(dbManager.getSessionStore().storeObservations).toHaveBeenCalled();
    // Below threshold — no respawn yet.
    expect(sessionManager.respawnPoisonedSession).not.toHaveBeenCalled();
  });

  it('truncated=true reaching the threshold escalates to a respawn (chronic truncation)', async () => {
    // One short of the threshold (3) — the next truncation reaches it.
    const session = makeSession({ consecutiveInvalidOutputs: 2 });
    const dbManager = makeDbManager();
    const sessionManager = makeSessionManager();

    await processAgentResponse(
      VALID_XML, session, dbManager, sessionManager,
      undefined, 0, null, 'API', undefined, undefined,
      true  // truncated
    );

    expect(session.consecutiveInvalidOutputs).toBe(3);
    // At the threshold: respawn, and DO NOT persist (the respawn re-queues the
    // pending messages — persisting here would double-store after re-claim).
    expect(sessionManager.respawnPoisonedSession).toHaveBeenCalledWith(session.sessionDbId);
    expect(dbManager.getSessionStore().storeObservations).not.toHaveBeenCalled();
  });

  it('resets consecutiveInvalidOutputs when truncated is omitted (default false) and parse is valid', async () => {
    const session = makeSession({ consecutiveInvalidOutputs: 2 });

    await processAgentResponse(
      VALID_XML, session, makeDbManager(), makeSessionManager(),
      undefined, 0, null, 'API', undefined, undefined
      // no truncated arg
    );

    // Counter must be reset to 0 on a clean valid parse
    expect(session.consecutiveInvalidOutputs).toBe(0);
  });
});
