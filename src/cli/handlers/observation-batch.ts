// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
//
// PostToolBatch fires once after a whole batch of parallel tool calls resolves
// (Claude Code only — Grok/Codex have no such event and keep per-call
// PostToolUse). We do the project/cwd guard ONCE, then post one observation per
// tool call in the batch. Each POST is byte-shape-identical to the single-tool
// observationHandler's payload, so the worker's /api/sessions/observations
// consumer (ingestObservation, which JSON.stringifies tool_response opaquely)
// is unchanged.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const observationBatchHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolCalls } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolBatch hook input for session ${sessionId}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping batch observation', { cwd });
      return { continue: true, suppressOutput: true };
    }

    logger.dataIn('HOOK', `PostToolBatch: ${toolCalls.length} tool call(s)`, {});

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (!call || !call.toolName) continue;
      const result = await executeWithWorkerFallback<{ status?: string }>(
        '/api/sessions/observations',
        'POST',
        {
          contentSessionId: sessionId,
          platformSource,
          tool_name: call.toolName,
          tool_input: call.toolInput,
          tool_response: call.toolResponse,
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          tool_use_id: call.toolUseId,
        },
      );
      if (isWorkerFallback(result)) {
        // Worker unreachable — bail on the rest of the batch; the SessionStart
        // start hook re-launches it, and the next batch will capture. Batching
        // means one outage drops the whole remaining batch (vs 1 per-tool under
        // PostToolUse), so log the dropped count to make the loss diagnosable.
        const dropped = toolCalls.length - i;
        logger.warn('HOOK', 'PostToolBatch: worker unreachable — dropping remaining batch observations', {
          dropped,
          total: toolCalls.length,
        });
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    }

    logger.debug('HOOK', 'Batch observations sent successfully via worker', { count: toolCalls.length });
    return { continue: true, suppressOutput: true };
  },
};
