import { Database } from './node-sqlite-compat.js';
import { logger } from '../../utils/logger.js';

export type FeedbackSignal = 'retrieval' | 'injection';

/**
 * Record a usage signal for observations. Best-effort — this runs on the
 * search / context-injection hot path, so it must NEVER throw into that path.
 * The signals it writes are what {@link runCompactionOnOpenDb}'s low-signal
 * selection prunes by (observations that were never retrieved or injected).
 */
export function recordObservationFeedback(
  db: Database,
  observationIds: number[],
  signalType: FeedbackSignal,
  sessionDbId: number | null = null
): void {
  if (observationIds.length === 0) return;
  try {
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT INTO observation_feedback (observation_id, signal_type, session_db_id, created_at_epoch) VALUES (?, ?, ?, ?)'
    );
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id, signalType, sessionDbId, now);
    });
    tx(observationIds);
  } catch (error) {
    logger.warn('SYSTEM', 'recordObservationFeedback failed (non-fatal)', { signalType, count: observationIds.length }, error as Error);
  }
}
