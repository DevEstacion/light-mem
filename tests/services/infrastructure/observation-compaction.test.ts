/**
 * Correctness guard for the #1 compaction risk: the `vectors` table has no FK
 * or trigger tying it to `observations`, so a delete that forgets its paired
 * vector rows silently orphans them. This exercises the low-signal deletion
 * path (no LLM flatten, so no Agent SDK dependency) and asserts that every
 * deleted observation's vector rows are gone too.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/services/sqlite/node-sqlite-compat.js';
import { LocalVectorStore } from '../../../src/services/sync/LocalVectorStore.js';
import { runCompactionOnOpenDb } from '../../../src/services/infrastructure/ObservationCompaction.js';

const COLLECTION = 'cm__light-mem';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      type TEXT,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      content_hash TEXT,
      created_at TEXT,
      created_at_epoch INTEGER,
      merged_into_project TEXT,
      metadata TEXT
    )
  `);
  db.run(`
    CREATE TABLE observation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      session_db_id INTEGER,
      created_at_epoch INTEGER NOT NULL,
      metadata TEXT
    )
  `);
  db.run(`
    CREATE TABLE vectors (
      doc_id TEXT PRIMARY KEY, collection TEXT NOT NULL, sqlite_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL, project TEXT NOT NULL, merged_into_project TEXT,
      created_at_epoch INTEGER, document TEXT NOT NULL, embedding BLOB NOT NULL, metadata TEXT NOT NULL
    )
  `);
  LocalVectorStore.init(db);
  return db;
}

function seedObservation(db: Database, id: number, narrative: string, facts: string[], epoch: number): void {
  db.prepare(`
    INSERT INTO observations (id, memory_session_id, project, type, title, narrative, facts, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'sess-1', 'p', 'discovery', `Title ${id}`, narrative, JSON.stringify(facts), epoch);

  const base = { sqlite_id: id, doc_type: 'observation', project: 'p', created_at_epoch: epoch };
  const docs = [
    { id: `obs_${id}_narrative`, document: narrative, metadata: { ...base, field_type: 'narrative' } },
    ...facts.map((f, i) => ({ id: `obs_${id}_fact_${i}`, document: f, metadata: { ...base, field_type: 'fact', fact_index: i } })),
  ];
  LocalVectorStore.getInstance().addDocuments(COLLECTION, docs);
}

describe('ObservationCompaction — vector integrity', () => {
  beforeEach(() => makeDb());

  it('never leaves an orphaned vectors row for a low-signal-deleted observation', async () => {
    const db = makeDb();
    const oldEpoch = Date.now() - 40 * 86_400_000; // older than lowSignalMinAgeDays (30), younger than ageDays (180)

    // Two clearly-distinct observations (not near-duplicates → no LLM flatten
    // path), neither with any feedback row → both are low-signal.
    seedObservation(db, 1, 'Refactored the authentication middleware in login flow', ['login.ts:42'], oldEpoch);
    seedObservation(db, 2, 'Documented the deployment pipeline for the billing service', ['deploy.md:10'], oldEpoch);

    // Activate the feedback subsystem with an unrelated signal — low-signal
    // pruning is skipped entirely when observation_feedback is empty.
    db.prepare('INSERT INTO observation_feedback (observation_id, signal_type, created_at_epoch) VALUES (?, ?, ?)').run(999, 'retrieval', Date.now());

    const before = db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get() as { n: number };
    expect(before.n).toBe(4); // 2 narrative + 2 fact rows

    const result = await runCompactionOnOpenDb(db, { dryRun: false, nearDupThreshold: 0.999 });

    expect(result.observationsDeleted).toBe(2);
    expect(result.groups.some(g => g.kind === 'low_signal')).toBe(true);

    const survivingObs = db.prepare('SELECT id FROM observations WHERE id IN (1, 2)').all();
    expect(survivingObs.length).toBe(0);

    const orphans = db.prepare(
      `SELECT COUNT(*) AS n FROM vectors WHERE sqlite_id IN (1, 2)`
    ).get() as { n: number };
    expect(orphans.n).toBe(0); // paired vector rows must be gone, not just the observations rows

    expect(result.vectorRowsDeleted).toBe(4);
  });

  it('dry-run reports low-signal candidates without deleting anything', async () => {
    const db = makeDb();
    const oldEpoch = Date.now() - 40 * 86_400_000;
    seedObservation(db, 10, 'Some old observation nobody ever retrieved', [], oldEpoch);
    db.prepare('INSERT INTO observation_feedback (observation_id, signal_type, created_at_epoch) VALUES (?, ?, ?)').run(999, 'retrieval', Date.now());

    const result = await runCompactionOnOpenDb(db, { dryRun: true, nearDupThreshold: 0.999 });

    expect(result.dryRun).toBe(true);
    expect(result.observationsDeleted).toBe(0);
    const still = db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    expect(still.n).toBe(1);
    const lowSignalGroup = result.groups.find(g => g.kind === 'low_signal');
    expect(lowSignalGroup?.sourceObservationIds).toContain(10);
  });

  it('keeps observations that have a feedback signal', async () => {
    const db = makeDb();
    const oldEpoch = Date.now() - 40 * 86_400_000;
    seedObservation(db, 20, 'This one was retrieved at least once', [], oldEpoch);
    db.prepare('INSERT INTO observation_feedback (observation_id, signal_type, created_at_epoch) VALUES (?, ?, ?)')
      .run(20, 'retrieval', Date.now());

    const result = await runCompactionOnOpenDb(db, { dryRun: false, nearDupThreshold: 0.999 });

    expect(result.observationsDeleted).toBe(0);
    const still = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id = 20').get() as { n: number };
    expect(still.n).toBe(1);
  });

  it('skips low-signal pruning entirely when no feedback has been recorded yet', async () => {
    const db = makeDb();
    const oldEpoch = Date.now() - 40 * 86_400_000;
    seedObservation(db, 30, 'Old observation, but the feedback subsystem has zero rows', [], oldEpoch);

    // observation_feedback is empty → "never retrieved" is indistinguishable
    // from "not yet retrieved" → the run must delete nothing.
    const result = await runCompactionOnOpenDb(db, { dryRun: false, nearDupThreshold: 0.999 });

    expect(result.observationsDeleted).toBe(0);
    expect(result.groups.some(g => g.kind === 'low_signal')).toBe(false);
    const still = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id = 30').get() as { n: number };
    expect(still.n).toBe(1);
  });
});
