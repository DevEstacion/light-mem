
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

    logger.info('API', 'Starting direct Messages API session', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      model: modelId,
      baseUrl,
      authMethod
    });

    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'init';

    for await (const message of this.messageGenerator(session)) {
      if (session.abortController.signal.aborted) {
        logger.warn('API', 'Session aborted before message', { sessionDbId: session.sessionDbId });
        break;
      }

      const text = await this.callMessagesApi({
        baseUrl,
        authToken,
        model: modelId,
        systemPrompt: message.content,
        maxTokens: 4096,
      });

      if (!text) {
        continue;
      }

      const responseSize = text.length;
      const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;
      const discoveryTokens = Math.max(0, (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse);

      if (text.includes('prompt is too long') || text.includes('context window')) {
        logger.error('API', 'Context overflow detected — forcing fresh start', {
          sessionDbId: session.sessionDbId
        });
        session.abortReason = 'overflow';
        try { session.abortController.abort(); } catch { /* best-effort */ }
        break;
      }

      if (text.includes('Invalid API key')) {
        throw new Error('Invalid API key: check ANTHROPIC_AUTH_TOKEN in ~/.light-mem/.env');
      }

      if (responseSize > 100) {
        const truncated = text.substring(0, 100) + '...';
        logger.dataOut('API', `Response received (${responseSize} chars)`, {
          sessionId: session.sessionDbId,
          promptNumber: session.lastPromptNumber
        }, truncated);
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
        modelId
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

  private async callMessagesApi(args: {
    baseUrl: string;
    authToken: string;
    model: string;
    systemPrompt: string;
    maxTokens: number;
  }): Promise<string> {
    // The systemPrompt is the full prompt (init/observation/summary) built
    // by build*Prompt in src/sdk/prompts.ts. It already contains role,
    // schema, and example instructions inline. Send as a single user
    // message — duplicating into `system` was observed to cause the
    // model to emit raw-text <observation> blocks the parser rejects.
    const body = {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [{ role: 'user', content: args.systemPrompt }],
      stream: true,
    };

    const res = await fetch(`${args.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': args.authToken,
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      return this.parseNonStreamingResponse(res);
    }
    return this.parseStreamingResponse(res);
  }

  private async parseStreamingResponse(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response had no body reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const blocks: Array<{ index: number; text: string }> = [];

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

          let evt: { type?: string; index?: number; delta?: { type?: string; text?: string }; message?: { usage?: { input_tokens?: number; output_tokens?: number } } };
          try { evt = JSON.parse(data); } catch { continue; }

          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
            const idx = evt.index ?? blocks.length;
            let block = blocks.find(b => b.index === idx);
            if (!block) {
              block = { index: idx, text: '' };
              blocks.push(block);
            }
            block.text += evt.delta.text;
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
    return blocks.map(b => b.text).join('');
  }

  private async parseNonStreamingResponse(res: Response): Promise<string> {
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    if (!Array.isArray(data.content)) {
      throw new Error('Non-streaming response missing content array');
    }
    return data.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
  }

  private getModelId(): string {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return resolveTierAlias(settings.LIGHT_MEM_MODEL, settings);
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