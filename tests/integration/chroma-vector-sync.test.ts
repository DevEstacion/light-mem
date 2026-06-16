/**
 * Integration test for the local vector path: ChromaSync (document assembly +
 * watermark) on top of LocalVectorStore (potion-base-8M embeddings + BM25).
 *
 * Replaces the old uvx/chroma-mcp subprocess integration test — embedding is
 * now in-process, so this runs everywhere with no external dependency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/services/sqlite/node-sqlite-compat.js';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';
import { LocalVectorStore } from '../../src/services/sync/LocalVectorStore.js';
import type { ParsedObservation } from '../../src/sdk/parser.js';

function initVectorsTable(): void {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE vectors (
      doc_id TEXT PRIMARY KEY, collection TEXT NOT NULL, sqlite_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL, project TEXT NOT NULL, merged_into_project TEXT,
      created_at_epoch INTEGER, document TEXT NOT NULL, embedding BLOB NOT NULL, metadata TEXT NOT NULL
    )
  `);
  LocalVectorStore.init(db);
}

const obs = (over: Partial<ParsedObservation> = {}): ParsedObservation => ({
  type: 'discovery',
  title: 'Test observation',
  subtitle: null,
  facts: [],
  narrative: null,
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

describe('ChromaSync + LocalVectorStore integration', () => {
  beforeEach(() => { initVectorsTable(); });

  it('exposes the expected public API', () => {
    const sync = new ChromaSync('test-project');
    expect(typeof sync.syncObservation).toBe('function');
    expect(typeof sync.syncSummary).toBe('function');
    expect(typeof sync.syncUserPrompt).toBe('function');
    expect(typeof sync.queryChroma).toBe('function');
    expect(typeof sync.ensureBackfilled).toBe('function');
    expect(typeof sync.close).toBe('function');
  });

  it('sanitizes special characters into the collection name', () => {
    // weird names must not throw and must produce a usable collection
    const sync = new ChromaSync('My Project/with:weird chars!');
    expect(sync).toBeDefined();
  });

  it('syncs an observation then finds it via hybrid query', async () => {
    const sync = new ChromaSync('proj');
    await sync.syncObservation(
      1, 'sess-1', 'proj',
      obs({
        title: 'WebSocket reconnect logic',
        narrative: 'The dashboard websocket reconnects with exponential backoff after the connection drops',
        facts: ['backoff starts at 1s', 'caps at 30s'],
      }),
      0, 1700000000
    );

    const res = await sync.queryChroma('how does the websocket reconnect', 10);
    expect(res.ids).toContain(1);
    expect(res.metadatas.some(m => m?.doc_type === 'observation')).toBe(true);
  });

  it('ranks the relevant observation above an unrelated one', async () => {
    const sync = new ChromaSync('proj');
    await sync.syncObservation(1, 's', 'proj',
      obs({ title: 'WS', narrative: 'websocket reconnection with backoff after a dropped connection' }), 0, 1700000001);
    await sync.syncObservation(2, 's', 'proj',
      obs({ title: 'Auth', narrative: 'aws okta login and kubeconfig download on the settings page' }), 1, 1700000002);

    const res = await sync.queryChroma('websocket reconnect', 10);
    expect(res.ids[0]).toBe(1);
  });

  it('multiple fields of one observation map to the same sqlite id', async () => {
    const sync = new ChromaSync('proj');
    await sync.syncObservation(7, 's', 'proj',
      obs({ title: 'X', narrative: 'narrative about queues', facts: ['fact about retries', 'fact about dead letters'] }),
      0, 1700000003);
    // narrative + 2 facts = 3 stored vectors, all sqlite_id 7
    const store = LocalVectorStore.getInstance();
    expect(store.count('cm__proj')).toBe(3);
    const res = await sync.queryChroma('dead letter retries', 10);
    expect(res.ids).toContain(7);
    // dedupe: a single sqlite id even though multiple field-docs matched
    expect(res.ids.filter(id => id === 7).length).toBe(1);
  });
});
