
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth, getAuthMethodDescription } from '../../shared/EnvManager.js';
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, type WorkerRef } from './agents/index.js';
import { resolveTierAlias } from './model-aliases.js';
import { classifyClaudeError } from './ClaudeProvider.js';
import { AsyncSemaphore } from './AsyncSemaphore.js';

/**
 * Drop-in replacement for ClaudeProvider that calls the Anthropic Messages
 * API directly via fetch(), bypassing the Claude Agent SDK and the
 * `claude` binary requirement.
 *
 * Why this exists: ClaudeProvider spawns a `claude` subprocess and pipes an
 * SDK query through it. On hosts without Claude Code installed (only OpenCode,
 * only API-key setups, or hosts that can't run the SDK's bundled binary) the
 * spawn fails with "Claude executable not found" and observation compression
 * never happens — hooks fire, events queue, but nothing gets stored as an
 * observation. ClaudeApiProvider uses the same ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN that the SDK would, but speaks the Messages API
 * directly.
 *
 * Tradeoffs vs ClaudeProvider:
 *   + No `claude` binary required.
 *   + Works on hosts that only have a single CLI (e.g. OpenCode).
 *   + One fewer subprocess per observation batch.
 *   - No multi-turn tool use from the agent side (the SDK lets the agent
 *     call Bash/Read/etc. while compressing; we don't). For observation
 *     compression this is fine — the prompt is "extract structure from this
 *     text," not "go investigate the repo."
 *   - No live SDK session resume. Each user message from the message
 *     generator triggers an independent Messages API call. The
 *     `memory_session_id` field stays a synthetic per-session value rather
 *     than an SDK-issued UUID.
 *
 * Selected when LIGHT_MEM_CLAUDE_PROVIDER=api (or auto if the `claude`
 * binary is not on PATH). Default is the SDK-backed ClaudeProvider for
 * backward compat.
 *
 * Streaming: prefers `stream: true` SSE responses (Anthropic's recommended
 * mode). If the API doesn't return text/event-stream, falls back to a
 * non-streaming POST and processes the full response once.
 */

// Module-scoped semaphore: all API sessions in this worker share one cap.
// Capacity is read once at first startSession call.
let _semaphore: AsyncSemaphore | null = null;

function getSemaphore(capacity: number): AsyncSemaphore {
  if (!_semaphore) {
    _semaphore = new AsyncSemaphore(capacity);
  }
  return _semaphore;
}

// Exported for test-harness access only — not part of the public API.
export { getSemaphore as __getSemaphoreForTesting };

/** Retry loop constants. Tests can override via CallArgs. */
const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30_000;
const MAX_ATTEMPTS = 3;

type CallArgs = {
  baseUrl: string;
  authToken: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  signal: AbortSignal;
  /** Backoff base milliseconds — injectable to speed up tests. */
  BASE_MS?: number;
  /** Backoff ceiling milliseconds — injectable to speed up tests. */
  CAP_MS?: number;
};

type ApiResult = { text: string; stopReason: string | null };

/**
 * Abort-aware sleep. Rejects if signal fires during the wait.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    // Remove the abort listener when the timer fires normally, so it doesn't
    // leak onto the long-lived session signal across many backoff sleeps.
    const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ClaudeApiProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, _worker?: WorkerRef): Promise<void> {
    const modelId = session.modelOverride || this.getModelId();
    session.lastModelId = typeof modelId === 'string' ? modelId : undefined;

    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());
    const authMethod = getAuthMethodDescription();
    const baseUrl = (isolatedEnv.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const authToken = isolatedEnv.ANTHROPIC_AUTH_TOKEN || '';

    if (!authToken) {
      throw new Error(
        'ClaudeApiProvider: no ANTHROPIC_AUTH_TOKEN in ~/.light-mem/.env. ' +
        'Set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL in the env, or set CLAUDE_CODE_USE_BEDROCK=1 with AWS creds.'
      );
    }

    // The SDK captures memory_session_id from its first response. Without an
    // SDK we synthesize one from content_session_id; processAgentResponse
    // short-circuits storage when memorySessionId is null.
    if (!session.memorySessionId) {
      session.memorySessionId = session.contentSessionId;
      this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(
        session.sessionDbId,
        session.contentSessionId
      );
      logger.info('SESSION', `Synthesized memory_session_id for API provider`, {
        sessionId: session.sessionDbId,
        memorySessionId: session.contentSessionId,
      });
    }

    logger.info('API', 'Starting direct Messages API session', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      model: modelId,
      baseUrl,
      authMethod
    });

    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'init';

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = parseInt(settings.LIGHT_MEM_MAX_CONCURRENT_AGENTS, 10) || 2;
    const sem = getSemaphore(maxConcurrent);

    for await (const message of this.messageGenerator(session)) {
      if (session.abortController.signal.aborted) {
        logger.warn('API', 'Session aborted before message', { sessionDbId: session.sessionDbId });
        break;
      }

      await sem.acquire(session.abortController.signal);
      let result: ApiResult;
      try {
        result = await this.callMessagesApi({
          baseUrl,
          authToken,
          model: modelId,
          systemPrompt: message.content,
          maxTokens: 4096,
          signal: session.abortController.signal,
        });
      } finally {
        sem.release();
      }

      const { text, stopReason } = result;

      if (!text) {
        continue;
      }

      const responseSize = text.length;
      const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;
      const discoveryTokens = Math.max(0, (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse);

      if (stopReason === 'max_tokens') {
        logger.warn('API', `Response truncated at max_tokens — prompt #${session.lastPromptNumber}, ${responseSize} chars received. Partial XML will be salvaged if parseable.`, {
          sessionId: session.sessionDbId,
          promptNumber: session.lastPromptNumber,
          responseSize,
        });
      } else if (responseSize > 100) {
        const preview = text.substring(0, 100) + '...';
        logger.dataOut('API', `Response received (${responseSize} chars)`, {
          sessionId: session.sessionDbId,
          promptNumber: session.lastPromptNumber
        }, preview);
      }

      await processAgentResponse(
        text,
        session,
        this.dbManager,
        this.sessionManager,
        _worker,
        discoveryTokens,
        session.earliestPendingTimestamp,
        'API',
        undefined,
        modelId,
        stopReason === 'max_tokens'  // truncated flag
      );
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('API', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  private async *messageGenerator(session: ActiveSession): AsyncIterableIterator<{ content: string }> {
    const mode = ModeManager.getInstance().getActiveMode();
    const isInitPrompt = session.lastPromptNumber === 1;

    const initPrompt = isInitPrompt
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });
    yield { content: initPrompt };

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.type === 'observation') {
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        const obsPrompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: Date.now(),
          cwd: message.cwd
        });

        session.conversationHistory.push({ role: 'user', content: obsPrompt });
        yield { content: obsPrompt };
      } else if (message.type === 'summarize') {
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_assistant_message: message.last_assistant_message || ''
        }, mode);

        session.conversationHistory.push({ role: 'user', content: summaryPrompt });
        yield { content: summaryPrompt };
      }
    }
  }

  /**
   * Call the Messages API with a bounded retry loop (up to MAX_ATTEMPTS).
   * Rate-limit (429) and transient (529/5xx/network) errors are retried with
   * backoff; unrecoverable / auth errors throw immediately.
   *
   * `fetchImpl` defaults to the global `fetch` and is injectable for tests.
   */
  async callMessagesApi(
    args: CallArgs,
    fetchImpl: typeof fetch = fetch
  ): Promise<ApiResult> {
    const BASE_MS = args.BASE_MS ?? DEFAULT_BASE_MS;
    const CAP_MS = args.CAP_MS ?? DEFAULT_CAP_MS;

    const body = {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [{ role: 'user', content: args.systemPrompt }],
      stream: true,
    };

    const headers = {
      'content-type': 'application/json',
      'x-api-key': args.authToken,
      'anthropic-version': '2023-06-01',
      'accept': 'text/event-stream',
    };

    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${args.baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: args.signal,
        });
      } catch (fetchErr) {
        // Network-level fetch rejection (DNS failure, connection refused, etc.)
        lastErr = fetchErr;
        const classified = classifyClaudeError(fetchErr);
        if (classified.kind === 'unrecoverable' || classified.kind === 'auth_invalid' || classified.kind === 'quota_exhausted') {
          throw classified;
        }
        // transient (network errors carry no .status; rate_limit cannot arise
        // here — classifyClaudeError needs status 429). Back off and retry,
        // unless this was the last attempt (no point sleeping before the throw).
        if (attempt < MAX_ATTEMPTS - 1) {
          const backoffMs = Math.min(Math.pow(2, attempt) * BASE_MS, CAP_MS);
          logger.warn('API', `fetch rejected (attempt ${attempt + 1}/${MAX_ATTEMPTS}), backing off ${backoffMs}ms`, {
            error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
          await abortableSleep(backoffMs, args.signal);
        }
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errType: string | undefined;
        try {
          const parsed = JSON.parse(errText);
          errType = parsed?.error?.type;
        } catch { /* ignore */ }

        // Build an error object the classifier can read via .status / .error.type
        const rawErr = Object.assign(new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`), {
          status: res.status,
          error: errType ? { type: errType } : undefined,
        });
        lastErr = rawErr;
        const classified = classifyClaudeError(rawErr);

        if (classified.kind === 'unrecoverable' || classified.kind === 'auth_invalid' || classified.kind === 'quota_exhausted') {
          throw classified;
        }

        // Last attempt — don't sleep before falling through to the throw.
        if (attempt >= MAX_ATTEMPTS - 1) {
          continue;
        }

        // rate_limit: honor Retry-After header if present, else exponential backoff
        let sleepMs: number;
        if (classified.kind === 'rate_limit') {
          const retryAfterHeader = res.headers.get('retry-after');
          if (retryAfterHeader !== null) {
            const secs = parseFloat(retryAfterHeader);
            sleepMs = isNaN(secs) ? Math.min(Math.pow(2, attempt) * BASE_MS, CAP_MS) : secs * 1000;
          } else {
            sleepMs = Math.min(Math.pow(2, attempt) * BASE_MS, CAP_MS);
          }
        } else {
          // transient
          sleepMs = Math.min(Math.pow(2, attempt) * BASE_MS, CAP_MS);
        }

        logger.warn('API', `HTTP ${res.status} (${classified.kind}) on attempt ${attempt + 1}/${MAX_ATTEMPTS}, retrying in ${sleepMs}ms`, {
          status: res.status,
          errType,
        });
        await abortableSleep(sleepMs, args.signal);
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        return this.parseNonStreamingResponse(res);
      }
      return this.parseStreamingResponse(res);
    }

    // All attempts exhausted
    throw classifyClaudeError(lastErr);
  }

  private async parseStreamingResponse(res: Response): Promise<ApiResult> {
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response had no body reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const blocks: Array<{ index: number; text: string }> = [];
    let stopReason: string | null = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          const dataLines: string[] = [];
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');
          if (data === '[DONE]') continue;

          let evt: {
            type?: string;
            index?: number;
            delta?: { type?: string; text?: string; stop_reason?: string };
            usage?: { output_tokens?: number };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          };
          try { evt = JSON.parse(data); } catch { continue; }

          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
            const idx = evt.index ?? blocks.length;
            let block = blocks.find(b => b.index === idx);
            if (!block) {
              block = { index: idx, text: '' };
              blocks.push(block);
            }
            block.text += evt.delta.text;
          } else if (evt.type === 'message_delta') {
            // Carries stop_reason and final output token count.
            if (evt.delta?.stop_reason) {
              stopReason = evt.delta.stop_reason;
            }
            // evt.usage?.output_tokens captured here but not wired into session
            // counters in this change (out of scope per spec, see comment in
            // message_start handler below).
          } else if (evt.type === 'message_start' && evt.message?.usage) {
            // We don't surface token usage back into session counters in this
            // first cut — ClaudeProvider does, but doing it correctly here
            // requires also tracking cache_creation/cache_read, which the
            // streaming protocol reports via separate events. Defer to a
            // follow-up; the discovery_tokens calc above treats each call
            // as 0 incremental tokens, which is conservative but not wrong.
          } else if (evt.type === 'error') {
            const errMsg = (evt as any).error?.message || JSON.stringify(evt);
            throw new Error(`Anthropic streaming error: ${errMsg}`);
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* best-effort */ }
    }

    blocks.sort((a, b) => a.index - b.index);
    return { text: blocks.map(b => b.text).join(''), stopReason };
  }

  private async parseNonStreamingResponse(res: Response): Promise<ApiResult> {
    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string | null;
    };
    if (!Array.isArray(data.content)) {
      throw new Error('Non-streaming response missing content array');
    }
    const text = data.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
    return { text, stopReason: data.stop_reason ?? null };
  }

  private getModelId(): string {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return resolveTierAlias(settings.LIGHT_MEM_MODEL, settings);
  }
}

/**
 * Test-only subclass that exposes `callMessagesApi` as a public method so
 * tests can inject mock fetch implementations without needing to go through
 * the full `startSession` / message-generator flow.
 */
export class ClaudeApiProviderTestHarness extends ClaudeApiProvider {
  constructor() {
    // Pass dummy stubs — test-harness only calls callMessagesApi directly.
    super(null as any, null as any);
  }

  // Re-expose as public for test access.
  callMessagesApi(args: CallArgs, fetchImpl?: typeof fetch): Promise<ApiResult> {
    return super.callMessagesApi(args, fetchImpl);
  }
}

// Lightweight env sanitizer: same behavior as the supervisor's sanitizeEnv
// for our narrow needs. Avoids pulling in a heavier dep just for this class.
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    // Drop bash function exports and process-pollution markers.
    if (v.includes('() {')) continue;
    out[k] = v;
  }
  return out;
}
