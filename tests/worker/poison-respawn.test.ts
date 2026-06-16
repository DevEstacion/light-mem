import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';

// No supervisor/process-registry mocks: respawnPoisonedSession only calls
// getSdkProcessForSession (returns undefined for a session that never spawned
// an SDK subprocess) and does not call getSupervisor, so the real modules are
// safe here. Mocking them with mock.module would leak globally across the bun
// run and break the supervisor/shutdown test suites.

vi.mock('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

vi.mock('../../src/shared/worker-utils.js', () => ({ getWorkerPort: () => 37777 }));
vi.mock('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse, INVALID_OUTPUT_RESPAWN_THRESHOLD } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const mockWorker = { broadcastProcessingStatus: () => {} } as unknown as WorkerRef;

let spies: ReturnType<typeof vi.spyOn>[] = [];

describe('poison respawn (plan-11 #2485)', () => {
  beforeEach(() => {
    spies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    spies.forEach(s => s.mockRestore());
  });

  it('respawns immediately on a poisoned closure string and preserves pending messages', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    session.memorySessionId = 'mem-1';

    // Buffer two pending observations that must survive a respawn.
    await sm.queueObservation(1, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-1',
    });
    await sm.queueObservation(1, {
      tool_name: 'Edit', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-2',
    });
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);

    const respawnSpy = vi.spyOn(sm, 'respawnPoisonedSession');

    await processAgentResponse(
      'This session has been exhausted; I cannot continue.',
      session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
    );

    expect(respawnSpy).toHaveBeenCalledWith(1);
    // Pending messages preserved (buffer NOT disposed) so the fresh generator reprocesses them.
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);
    // Session still active (not deleted) and abort fired for a fresh spawn.
    expect(sm.getSession(1)).toBeDefined();
    expect(session.abortController.signal.aborted).toBe(true);
    expect(session.consecutiveInvalidOutputs).toBe(0); // reset on respawn
  });

  it('respawns only after N consecutive prose/idle outputs, not on the first', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await sm.queueObservation(2, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-a',
    });

    const respawnSpy = vi.spyOn(sm, 'respawnPoisonedSession');

    // First (threshold - 1) prose responses must NOT respawn.
    for (let i = 0; i < INVALID_OUTPUT_RESPAWN_THRESHOLD - 1; i++) {
      await processAgentResponse(
        'Just some prose, no XML here.',
        session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
      );
    }
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(session.consecutiveInvalidOutputs).toBe(INVALID_OUTPUT_RESPAWN_THRESHOLD - 1);

    // The Nth invalid output crosses the threshold and triggers respawn.
    await processAgentResponse(
      'Still just prose.',
      session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
    );
    expect(respawnSpy).toHaveBeenCalledWith(2);
  });

  it('respawnPoisonedSession preserves the buffer and resets context', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    session.conversationHistory.push({ role: 'assistant', content: 'poisoned turn' });
    session.consecutiveInvalidOutputs = 5;
    await sm.queueObservation(3, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-x',
    });

    await sm.respawnPoisonedSession(3);

    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1); // preserved
    expect(sm.getSession(3)).toBeDefined();
    expect(session.conversationHistory).toHaveLength(0);
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.memorySessionId).toBeNull();
    expect(session.abortController.signal.aborted).toBe(true);
  });
});
