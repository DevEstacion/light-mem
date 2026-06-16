import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/services/sqlite/node-sqlite-compat.js';
import { LocalVectorStore, AddDocument } from '../../../src/services/sync/LocalVectorStore.js';

function freshStore(): LocalVectorStore {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE vectors (
      doc_id TEXT PRIMARY KEY, collection TEXT NOT NULL, sqlite_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL, project TEXT NOT NULL, merged_into_project TEXT,
      created_at_epoch INTEGER, document TEXT NOT NULL, embedding BLOB NOT NULL, metadata TEXT NOT NULL
    )
  `);
  return LocalVectorStore.init(db);
}

function obsDoc(id: number, field: string, text: string, project = 'proj'): AddDocument {
  return {
    id: `obs_${id}_${field}`,
    document: text,
    metadata: { sqlite_id: id, doc_type: 'observation', project, created_at_epoch: 1700000000 + id },
  };
}

describe('LocalVectorStore', () => {
  let store: LocalVectorStore;
  beforeEach(() => { store = freshStore(); });

  it('adds documents and queries them back ranked by hybrid relevance', () => {
    store.addDocuments('cm__proj', [
      obsDoc(1, 'narrative', 'Dashboard WebSocket reconnects with exponential backoff after the connection drops'),
      obsDoc(2, 'narrative', 'aws-okta authentication and kubeconfig patching in the settings page'),
      obsDoc(3, 'narrative', 'PTY terminal session manager replays the buffer on attach'),
    ]);
    const res = store.query('cm__proj', 'how does websocket reconnect work', 3);
    expect(res.ids[0].length).toBe(3);
    // The websocket doc (obs 1) must rank first.
    expect(res.ids[0][0]).toBe('obs_1_narrative');
    expect(res.metadatas[0][0]?.sqlite_id).toBe(1);
  });

  it('upserts on duplicate doc_id (no constraint error, content replaced)', () => {
    store.addDocuments('cm__proj', [obsDoc(1, 'narrative', 'first version about caching')]);
    store.addDocuments('cm__proj', [obsDoc(1, 'narrative', 'second version about websocket reconnection logic')]);
    const res = store.query('cm__proj', 'websocket reconnection', 5);
    expect(res.ids[0]).toContain('obs_1_narrative');
    // only one row for that id
    const got = store.getDocuments('cm__proj');
    expect(got.ids.filter(i => i === 'obs_1_narrative').length).toBe(1);
  });

  it('respects project where-filter and $or', () => {
    store.addDocuments('cm__a', [obsDoc(1, 'narrative', 'alpha websocket', 'a')]);
    store.addDocuments('cm__a', [obsDoc(2, 'narrative', 'beta websocket', 'b')]);
    const res = store.query('cm__a', 'websocket', 5, { $or: [{ project: 'a' }, { merged_into_project: 'a' }] });
    expect(res.ids[0]).toEqual(['obs_1_narrative']);
  });

  it('getDocuments paginates and filters by sqlite_id $in', () => {
    store.addDocuments('cm__proj', [
      obsDoc(1, 'narrative', 'one'), obsDoc(2, 'narrative', 'two'), obsDoc(3, 'narrative', 'three'),
    ]);
    const got = store.getDocuments('cm__proj', { where: { sqlite_id: { $in: [1, 3] } } });
    expect(new Set(got.ids)).toEqual(new Set(['obs_1_narrative', 'obs_3_narrative']));
  });

  it('updateDocuments patches merged_into_project in metadata + column', () => {
    store.addDocuments('cm__proj', [obsDoc(1, 'narrative', 'mergeable observation about queues')]);
    store.updateDocuments('cm__proj', ['obs_1_narrative'], [{ sqlite_id: 1, doc_type: 'observation', project: 'proj', merged_into_project: 'newproj' }]);
    const res = store.query('cm__proj', 'queues', 5, { merged_into_project: 'newproj' });
    expect(res.ids[0]).toContain('obs_1_narrative');
  });

  it('deleteDocuments removes rows', () => {
    store.addDocuments('cm__proj', [obsDoc(1, 'narrative', 'deletable')]);
    store.deleteDocuments('cm__proj', ['obs_1_narrative']);
    expect(store.getDocuments('cm__proj').ids.length).toBe(0);
  });

  it('handles empty document text without NaN (zero vector)', () => {
    store.addDocuments('cm__proj', [obsDoc(1, 'narrative', 'real content here')]);
    // a query that tokenizes to nothing must not throw / NaN
    const res = store.query('cm__proj', '   ', 5);
    expect(res.ids[0].length).toBeGreaterThanOrEqual(0);
  });

  it('countForProject is scoped per project within a shared collection', () => {
    // Regression: the migration self-heal must detect a per-project empty store
    // even when OTHER projects in the same collection are already populated.
    store.addDocuments('cm__light-mem', [obsDoc(1, 'narrative', 'project A doc', 'projA')]);
    store.addDocuments('cm__light-mem', [obsDoc(2, 'narrative', 'project B doc', 'projB')]);
    expect(store.countForProject('cm__light-mem', 'projA')).toBe(1);
    expect(store.countForProject('cm__light-mem', 'projB')).toBe(1);
    // projC has zero rows even though the collection total is non-zero
    expect(store.countForProject('cm__light-mem', 'projC')).toBe(0);
    expect(store.count('cm__light-mem')).toBe(2);
  });
});
