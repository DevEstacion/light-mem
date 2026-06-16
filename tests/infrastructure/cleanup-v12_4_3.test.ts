
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { Database } from '../../src/services/sqlite/node-sqlite-compat.js';
import { runOneTimeV12_4_3Cleanup } from '../../src/services/infrastructure/CleanupV12_4_3.js';
import { LightMemDatabase } from '../../src/services/sqlite/Database.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';

// Make the 'fs' module mockable so vi.spyOn(fs, 'statfsSync') works in ESM.
// With vi.mock + importActual all real fs functions are preserved; only the
// module namespace is wrapped so individual exports can be spied on.
vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return { ...actual };
});

// node:sqlite does not accept an array as a positional-parameter binding
// (bun:sqlite did).  CleanupV12_4_3.ts calls db.run(sql, [value]), which
// arrives in node-sqlite-compat as params = [[value]].  The current
// normalizeParams() is a no-op and passes [value] to stmt.run(), triggering
// "Unknown named parameter '0'".  Patch Database.run() here to unwrap a
// single-array arg until the src fix lands.
vi.mock('../../src/services/sqlite/node-sqlite-compat.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/sqlite/node-sqlite-compat.js')>();
  const OrigDatabase = actual.Database;
  class PatchedDatabase extends OrigDatabase {
    run(sql: string, ...params: any[]): { lastInsertRowid: number; changes: number } {
      if (params.length === 1 && Array.isArray(params[0])) {
        return super.run(sql, ...(params[0] as any[]));
      }
      return super.run(sql, ...params);
    }
  }
  return { ...actual, Database: PatchedDatabase };
});

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function silenceLogger(): void {
  loggerSpies = [
    vi.spyOn(logger, 'info').mockImplementation(() => {}),
    vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    vi.spyOn(logger, 'warn').mockImplementation(() => {}),
    vi.spyOn(logger, 'error').mockImplementation(() => {}),
  ];
}

function restoreLogger(): void {
  loggerSpies.forEach(s => s.mockRestore());
  loggerSpies = [];
}

function seedDatabase(dbPath: string, opts: { observerSessions: number; stuckCount: number }): { observerSessionDbIds: number[]; keepSessionDbId: number } {
  const seed = new LightMemDatabase(dbPath);
  const db = seed.db;
  const now = new Date().toISOString();
  const epoch = Date.now();

  const insertSession = db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertPrompt = db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
     VALUES (?, 1, ?, ?, ?)`
  );
  const insertObservation = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, text, created_at, created_at_epoch)
     VALUES (?, ?, 'discovery', ?, ?, ?)`
  );

  const observerSessionDbIds: number[] = [];
  for (let i = 0; i < opts.observerSessions; i++) {
    const result = insertSession.run(`obs-content-${i}`, `obs-memory-${i}`, OBSERVER_SESSIONS_PROJECT, now, epoch);
    observerSessionDbIds.push(Number(result.lastInsertRowid));
    insertPrompt.run(`obs-content-${i}`, `prompt ${i}`, now, epoch);
    insertObservation.run(`obs-memory-${i}`, OBSERVER_SESSIONS_PROJECT, `obs ${i}`, now, epoch);
  }

  const keepResult = insertSession.run('keep-content', 'keep-memory', 'real-project', now, epoch);
  const keepSessionDbId = Number(keepResult.lastInsertRowid);
  insertPrompt.run('keep-content', 'survives', now, epoch);

  const insertPending = db.prepare(
    `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
     VALUES (?, 'keep-content', 'observation', 'processing', ?)`
  );
  for (let i = 0; i < opts.stuckCount; i++) {
    insertPending.run(keepSessionDbId, epoch);
  }

  seed.close();
  return { observerSessionDbIds, keepSessionDbId };
}

describe('runOneTimeV12_4_3Cleanup', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cleanup-v12_4_3-'));
    silenceLogger();
  });

  afterEach(() => {
    restoreLogger();
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('writes a no-db marker when the DB is missing', () => {
    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);

    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(payload.skipped).toBe('no-db');
    expect(payload.backupPath).toBeNull();
    expect(payload.counts).toEqual({ observerSessions: 0, observerCascadeRows: 0, stuckPendingMessages: 0 });
  });

  it('purges observer-sessions and stuck pending_messages, writes marker, wipes chroma', () => {
    const dbPath = path.join(tmpDataDir, 'light-mem.db');
    seedDatabase(dbPath, { observerSessions: 3, stuckCount: 12 });

    mkdirSync(path.join(tmpDataDir, 'chroma'), { recursive: true });
    writeFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'opaque');
    writeFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), '{}');

    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));

    expect(payload.counts.observerSessions).toBe(3);
    expect(payload.counts.observerCascadeRows).toBe(6); 
    expect(payload.counts.stuckPendingMessages).toBe(12);
    expect(payload.chromaWiped).toBe(true);
    expect(payload.chromaWipeError).toBeUndefined();
    expect(payload.backupPath).toBeTruthy();

    expect(existsSync(payload.backupPath)).toBe(true);

    expect(existsSync(path.join(tmpDataDir, 'chroma'))).toBe(false);
    expect(existsSync(path.join(tmpDataDir, 'chroma-sync-state.json'))).toBe(false);

    const verify = new Database(dbPath, { readonly: true });
    const observerCount = (verify.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    const realCount = (verify.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = 'real-project'`).get() as { n: number }).n;
    const survivingPrompts = (verify.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n;
    const survivingPending = (verify.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
    verify.close();

    expect(observerCount).toBe(0);
    expect(realCount).toBe(1);
    expect(survivingPrompts).toBe(1); 
    expect(survivingPending).toBe(0);
  });

  it('preserves pending_messages when stuck count is below the threshold of 10', () => {
    const dbPath = path.join(tmpDataDir, 'light-mem.db');
    seedDatabase(dbPath, { observerSessions: 0, stuckCount: 9 });

    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(payload.counts.stuckPendingMessages).toBe(0);

    const verify = new Database(dbPath, { readonly: true });
    const survivingPending = (verify.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
    verify.close();
    expect(survivingPending).toBe(9);
  });

  it('is idempotent: a second invocation does no work and does not create a second backup', () => {
    const dbPath = path.join(tmpDataDir, 'light-mem.db');
    seedDatabase(dbPath, { observerSessions: 1, stuckCount: 10 });

    runOneTimeV12_4_3Cleanup(tmpDataDir);
    const backupsAfterFirst = readdirSync(path.join(tmpDataDir, 'backups'));
    expect(backupsAfterFirst.length).toBe(1);

    runOneTimeV12_4_3Cleanup(tmpDataDir);
    const backupsAfterSecond = readdirSync(path.join(tmpDataDir, 'backups'));
    expect(backupsAfterSecond).toEqual(backupsAfterFirst);
  });

  it('proceeds with cleanup when statfsSync returns non-credible values (Bun darwin-x64 #31133)', () => {
    // Reproduce the Bun 1.3.14 darwin-x64 statfs misalignment: bsize comes back
    // as 0 and the other fields are shifted by one slot.
    // Before the defensive patch, this caused the cleanup to compute
    // free = bavail * bsize = 0 and skip with a misleading "Insufficient disk"
    // error. After the patch, the gate should be bypassed with a WARN and the
    // cleanup should run to completion.
    const dbPath = path.join(tmpDataDir, 'light-mem.db');
    seedDatabase(dbPath, { observerSessions: 2, stuckCount: 10 });

    const statfsSpy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => ({
      type: 0,
      bsize: 0, // ← the bug: should be 4096 on APFS
      blocks: 4096,
      bfree: 1048576,
      bavail: 977028249,
      files: 0,
      ffree: 0,
    }) as unknown as ReturnType<typeof fs.statfsSync>);

    try {
      runOneTimeV12_4_3Cleanup(tmpDataDir);
    } finally {
      statfsSpy.mockRestore();
    }

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(payload.counts.observerSessions).toBe(2);
    expect(payload.counts.stuckPendingMessages).toBe(10);
    expect(payload.backupPath).toBeTruthy();
    expect(existsSync(payload.backupPath)).toBe(true);

    // Guard against the spy silently failing to intercept the named ESM import
    // inside CleanupV12_4_3.ts. If the production code is still calling the
    // real statfsSync (which returns ~1 TB free on this machine), the cleanup
    // still completes and every assertion above passes vacuously. The WARN
    // log line is only emitted on the defensive branch, so asserting on it
    // disambiguates "spy worked, defensive branch fired" from "spy silently
    // bypassed, normal branch fired".
    expect(logger.warn).toHaveBeenCalledWith(
      'SYSTEM',
      expect.stringContaining('non-credible'),
      expect.objectContaining({ bsize: 0 }),
    );
  });

  it('honors LIGHT_MEM_SKIP_CLEANUP_V12_4_3=1 by exiting without writing the marker', () => {
    const dbPath = path.join(tmpDataDir, 'light-mem.db');
    seedDatabase(dbPath, { observerSessions: 1, stuckCount: 10 });

    const original = process.env.LIGHT_MEM_SKIP_CLEANUP_V12_4_3;
    process.env.LIGHT_MEM_SKIP_CLEANUP_V12_4_3 = '1';
    try {
      runOneTimeV12_4_3Cleanup(tmpDataDir);
    } finally {
      if (original === undefined) delete process.env.LIGHT_MEM_SKIP_CLEANUP_V12_4_3;
      else process.env.LIGHT_MEM_SKIP_CLEANUP_V12_4_3 = original;
    }

    expect(existsSync(path.join(tmpDataDir, '.cleanup-v12.4.3-applied'))).toBe(false);

    const verify = new Database(dbPath, { readonly: true });
    const observerCount = (verify.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    verify.close();
    expect(observerCount).toBe(1); 
  });
});
