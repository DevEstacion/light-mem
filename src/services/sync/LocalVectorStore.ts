/**
 * Local, in-process replacement for the Chroma vector store.
 *
 * Reimplements the handful of Chroma operations ChromaSync depends on
 * (create_collection / add / get / query / delete / update) against the
 * SQLite `vectors` table (migration 35) plus the bundled potion-base-8M
 * embedder. There is no subprocess, no uvx, no network — embedding happens
 * inline in Bun.
 *
 * Query uses the same HYBRID ranking the project's bake-off validated on real
 * data (potion cosine 0.7 + BM25 0.3 via reciprocal-rank fusion): semantic
 * similarity over the stored embeddings fused with BM25 over the stored
 * document text. ChromaSync calls these methods through the same shapes it
 * passed to `chromaMcp.callTool`, so its document-assembly, watermark, dedup,
 * and backfill logic are untouched.
 */
import { Database } from '../sqlite/node-sqlite-compat.js';
import { getEmbedder } from '../embed/index.js';
import { tokenize } from '../search/text/tokenize.js';
import { logger } from '../../utils/logger.js';

const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const RRF_K = 60;

// query() loads candidate rows into memory and scores them in JS (no ANN index).
// At realistic corpus sizes (hundreds–thousands per project) that is sub-10ms,
// but the cost is O(N), so cap the scan to bound worst-case latency. Newest
// documents are preferred when the cap is hit. Re-evaluate if corpora routinely
// exceed this (a real ANN/sqlite-vec backend would be the next step).
const MAX_QUERY_ROWS = 5000;

type WhereFilter = Record<string, any>;

interface VectorRow {
  doc_id: string;
  sqlite_id: number;
  doc_type: string;
  project: string;
  merged_into_project: string | null;
  created_at_epoch: number | null;
  document: string;
  embedding: Uint8Array;
  metadata: string;
}

export interface AddDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

export interface QueryResult {
  ids: string[][];
  metadatas: Array<Array<Record<string, any> | null>>;
  distances: number[][];
}

export interface GetResult {
  ids: string[];
  metadatas: Array<Record<string, any> | null>;
}

/** Pack a unit Float32 embedding into a little-endian BLOB. */
function packEmbedding(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

/** Read a stored BLOB back into a Float32Array view. */
function unpackEmbedding(blob: Uint8Array): Float32Array {
  // Copy to guarantee 4-byte alignment regardless of how bun:sqlite returns it.
  const aligned = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);
  // A Float32 embedding is always a multiple of 4 bytes. A non-multiple means a
  // corrupt or wrong-dimension BLOB; fail loudly rather than silently dropping a
  // trailing partial float (which would skew cosine scores with no diagnostic).
  if (aligned.byteLength % 4 !== 0) {
    throw new Error(`unpackEmbedding: BLOB length ${aligned.byteLength} is not a multiple of 4 — corrupt or wrong-model embedding`);
  }
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

export class LocalVectorStore {
  private static instance: LocalVectorStore | null = null;
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static init(db: Database): LocalVectorStore {
    LocalVectorStore.instance = new LocalVectorStore(db);
    return LocalVectorStore.instance;
  }

  static getInstance(): LocalVectorStore {
    if (!LocalVectorStore.instance) {
      throw new Error('LocalVectorStore not initialized — call LocalVectorStore.init(db) first');
    }
    return LocalVectorStore.instance;
  }

  /** No-op: collections are virtual (the `collection` column). Kept for API parity. */
  createCollection(_collectionName: string): void {
    /* virtual — nothing to create */
  }

  /** Number of stored vectors in a collection (used to detect a fresh/empty store). */
  count(collectionName: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE collection = ?').get(collectionName) as { n: number };
    return row?.n ?? 0;
  }

  /**
   * Number of stored vectors for one project within a collection. The collection
   * is shared across projects (cm__light-mem), so the migration self-heal must
   * scope its "empty store?" check per-project — otherwise an interrupted
   * backfill of project C is masked by rows from already-migrated projects.
   */
  countForProject(collectionName: string, project: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM vectors WHERE collection = ? AND project = ?'
    ).get(collectionName, project) as { n: number };
    return row?.n ?? 0;
  }

  /** Upsert documents: embed each `document` and store row-per-doc. */
  addDocuments(collectionName: string, docs: AddDocument[]): void {
    if (docs.length === 0) return;
    const embedder = getEmbedder();
    const stmt = this.db.prepare(`
      INSERT INTO vectors (doc_id, collection, sqlite_id, doc_type, project, merged_into_project, created_at_epoch, document, embedding, metadata)
      VALUES ($doc_id, $collection, $sqlite_id, $doc_type, $project, $merged, $epoch, $document, $embedding, $metadata)
      ON CONFLICT(doc_id) DO UPDATE SET
        sqlite_id=excluded.sqlite_id, doc_type=excluded.doc_type, project=excluded.project,
        merged_into_project=excluded.merged_into_project, created_at_epoch=excluded.created_at_epoch,
        document=excluded.document, embedding=excluded.embedding, metadata=excluded.metadata
    `);
    const tx = this.db.transaction((batch: AddDocument[]) => {
      for (const d of batch) {
        const m = d.metadata;
        const vec = embedder.embed(d.document);
        stmt.run({
          $doc_id: d.id,
          $collection: collectionName,
          $sqlite_id: Number(m.sqlite_id),
          $doc_type: String(m.doc_type ?? ''),
          $project: String(m.project ?? ''),
          $merged: m.merged_into_project != null ? String(m.merged_into_project) : null,
          $epoch: m.created_at_epoch != null ? Number(m.created_at_epoch) : null,
          $document: d.document,
          $embedding: packEmbedding(vec),
          $metadata: JSON.stringify(m),
        });
      }
    });
    tx(docs);
  }

  deleteDocuments(collectionName: string, ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM vectors WHERE collection = ? AND doc_id IN (${placeholders})`).run(collectionName, ...ids);
  }

  /** Patch stored metadata JSON for the given doc ids (used for merged_into_project). */
  updateDocuments(collectionName: string, ids: string[], metadatas: Array<Record<string, any>>): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`
      UPDATE vectors SET metadata = $metadata, merged_into_project = $merged WHERE collection = $collection AND doc_id = $doc_id
    `);
    const tx = this.db.transaction(() => {
      ids.forEach((id, i) => {
        const m = metadatas[i] ?? {};
        stmt.run({
          $metadata: JSON.stringify(m),
          $merged: m.merged_into_project != null ? String(m.merged_into_project) : null,
          $collection: collectionName,
          $doc_id: id,
        });
      });
    });
    tx();
  }

  /** Paginated scan of doc ids + metadata, optionally filtered. */
  getDocuments(
    collectionName: string,
    opts: { where?: WhereFilter; limit?: number; offset?: number } = {}
  ): GetResult {
    const { clause, params } = this.buildWhere(collectionName, opts.where);
    let sql = `SELECT doc_id, metadata FROM vectors WHERE ${clause} ORDER BY rowid`;
    if (opts.limit != null) sql += ` LIMIT ${Math.max(0, opts.limit | 0)}`;
    if (opts.offset != null) sql += ` OFFSET ${Math.max(0, opts.offset | 0)}`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ doc_id: string; metadata: string }>;
    return {
      ids: rows.map(r => r.doc_id),
      metadatas: rows.map(r => this.parseMeta(r.metadata)),
    };
  }

  /**
   * Hybrid semantic + BM25 query. Returns up to nResults rows in
   * Chroma's nested-array result shape. `distances` is 1 - fusedScore so that
   * lower = closer, matching Chroma's distance convention (values are only
   * used for ordering downstream, never as calibrated magnitudes).
   */
  query(
    collectionName: string,
    queryText: string,
    nResults: number,
    where?: WhereFilter
  ): QueryResult {
    const { clause, params } = this.buildWhere(collectionName, where);
    const rows = this.db.prepare(
      `SELECT doc_id, sqlite_id, doc_type, project, merged_into_project, created_at_epoch, document, embedding, metadata
       FROM vectors WHERE ${clause}
       ORDER BY created_at_epoch DESC
       LIMIT ${MAX_QUERY_ROWS}`
    ).all(...params) as VectorRow[];

    if (rows.length === MAX_QUERY_ROWS) {
      logger.warn('LOCAL_VECTOR', 'Query scan hit MAX_QUERY_ROWS cap — older documents excluded from ranking', {
        collection: collectionName,
        cap: MAX_QUERY_ROWS
      });
    }

    if (rows.length === 0) {
      return { ids: [[]], metadatas: [[]], distances: [[]] };
    }

    const embedder = getEmbedder();
    const q = embedder.embed(queryText);

    // A query that tokenizes to nothing (empty or fully out-of-vocab) yields a
    // zero embedding: cosine is 0 for every doc, so results fall back to BM25
    // alone. That is correct degraded behavior, but log it so poor recall on
    // such a query is diagnosable rather than mysterious.
    if (q.every(v => v === 0)) {
      logger.debug('LOCAL_VECTOR', 'Query produced a zero embedding — ranking by BM25 only', {
        queryPreview: queryText.slice(0, 80)
      });
    }

    // Semantic: cosine = dot product (vectors are unit length).
    const semantic = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const v = unpackEmbedding(rows[i].embedding);
      let dot = 0;
      const n = Math.min(v.length, q.length);
      for (let j = 0; j < n; j++) dot += v[j] * q[j];
      semantic[i] = dot;
    }

    // Keyword: BM25 over the stored documents (same tokenizer as FTS-side code).
    const keyword = this.bm25(queryText, rows.map(r => r.document));

    // Reciprocal-rank fusion of the two orderings. NOTE: in RRF the weights
    // scale each rank-list's CONTRIBUTION, not the underlying scores — RRF is
    // deliberately scale-invariant. The 0.7/0.3 split came from the bake-off
    // (which tied with a direct score-blend); RRF is kept for its robustness to
    // differing cosine/BM25 score distributions across arbitrary corpora.
    const semRank = rankPositions(semantic);
    const kwRank = rankPositions(keyword);
    const fused = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      fused[i] = SEMANTIC_WEIGHT / (RRF_K + semRank[i]) + KEYWORD_WEIGHT / (RRF_K + kwRank[i]);
    }

    const order = Array.from(fused.keys()).sort((a, b) => fused[b] - fused[a]).slice(0, nResults);
    return {
      ids: [order.map(i => rows[i].doc_id)],
      metadatas: [order.map(i => this.parseMeta(rows[i].metadata))],
      distances: [order.map(i => 1 - fused[i])],
    };
  }

  // --- internals ---------------------------------------------------------

  private parseMeta(raw: string): Record<string, any> | null {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Translate the subset of Chroma where-filters ChromaSync uses into SQL. */
  private buildWhere(collectionName: string, where?: WhereFilter): { clause: string; params: any[] } {
    const params: any[] = [collectionName];
    const parts: string[] = ['collection = ?'];
    if (where) {
      const sub = this.translateFilter(where, params);
      if (sub) parts.push(sub);
    }
    return { clause: parts.join(' AND '), params };
  }

  private translateFilter(where: WhereFilter, params: any[]): string | null {
    const conds: string[] = [];
    for (const [key, val] of Object.entries(where)) {
      if (key === '$and' && Array.isArray(val)) {
        const subs = val.map(w => this.translateFilter(w, params)).filter(Boolean) as string[];
        if (subs.length) conds.push(`(${subs.join(' AND ')})`);
      } else if (key === '$or' && Array.isArray(val)) {
        const subs = val.map(w => this.translateFilter(w, params)).filter(Boolean) as string[];
        if (subs.length) conds.push(`(${subs.join(' OR ')})`);
      } else {
        const col = this.columnFor(key);
        if (!col) {
          // An unrecognized filter key is silently un-filterable (only promoted
          // columns are queryable). Warn so a dropped filter doesn't masquerade
          // as "matched everything".
          logger.warn('LOCAL_VECTOR', `translateFilter: unknown filter key "${key}" — term ignored`);
          continue;
        }
        if (val && typeof val === 'object' && '$in' in val && Array.isArray(val.$in)) {
          if (val.$in.length === 0) { conds.push('0'); continue; }
          const ph = val.$in.map(() => '?').join(',');
          conds.push(`${col} IN (${ph})`);
          params.push(...val.$in);
        } else {
          conds.push(`${col} = ?`);
          params.push(val);
        }
      }
    }
    return conds.length ? conds.join(' AND ') : null;
  }

  /** Only metadata fields promoted to real columns are filterable. */
  private columnFor(key: string): string | null {
    switch (key) {
      case 'project': return 'project';
      case 'merged_into_project': return 'merged_into_project';
      case 'sqlite_id': return 'sqlite_id';
      case 'doc_type': return 'doc_type';
      default: return null;
    }
  }

  private bm25(query: string, docs: string[]): Float64Array {
    const k1 = 1.5;
    const b = 0.75;
    const N = docs.length;
    const docToks = docs.map(d => tokenize(d));
    const dl = docToks.map(t => t.length);
    const avgdl = dl.reduce((a, x) => a + x, 0) / Math.max(N, 1);
    const df = new Map<string, number>();
    for (const toks of docToks) {
      for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const qToks = tokenize(query);
    const scores = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const tf = new Map<string, number>();
      for (const t of docToks[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of qToks) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl[i] / avgdl)));
      }
      scores[i] = s;
    }
    return scores;
  }
}

/** Rank position (0 = highest score) for each index; ties broken by index. */
function rankPositions(scores: Float64Array): Int32Array {
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  const rank = new Int32Array(scores.length);
  order.forEach((idx, pos) => { rank[idx] = pos; });
  return rank;
}
