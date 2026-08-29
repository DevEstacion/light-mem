import path from 'path';
import { mkdirSync } from 'fs';
import { Database } from '../sqlite/node-sqlite-compat.js';
import { LocalVectorStore, type AddDocument } from '../sync/LocalVectorStore.js';
import { computeObservationContentHash } from '../sqlite/observations/store.js';
import { DATA_DIR, USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { resolveTierAlias } from '../worker/model-aliases.js';
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../sdk/hardened-options.js';

/**
 * Fixed collection name — everywhere else constructs `new ChromaSync('light-mem')`
 * whose sanitized collection is `cm__light-mem`. Compaction must delete/add vector
 * rows in the same collection.
 */
const VECTOR_COLLECTION = 'cm__light-mem';

export type OutlierKind = 'age' | 'near_dup' | 'low_signal';

export interface CompactionOptions {
  dryRun: boolean;
  project?: string;
  ageDays: number;
  nearDupThreshold: number;   // cosine similarity, 0..1
  lowSignalMinAgeDays: number;
  maxCandidateRows: number;   // bound for the O(n^2) near-dup scan
  /** Source DB file to VACUUM INTO before a non-dry-run mutation. */
  backupSourcePath?: string;
}

export interface CompactionGroup {
  kind: OutlierKind;
  sourceObservationIds: number[];
  flattenedObservationId: number | null;
  flattenedTitle: string;
}

export interface CompactionResult {
  dryRun: boolean;
  backupPath: string | null;
  groups: CompactionGroup[];
  observationsDeleted: number;
  observationsCreated: number;
  vectorRowsDeleted: number;
  vectorRowsCreated: number;
}

interface AgeCandidate {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at_epoch: number;
}

interface FlattenedObservation {
  type: string;
  title: string;
  subtitle: string | null;
  facts: string[];
  narrative: string;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

function defaultsFromSettings(): Pick<CompactionOptions, 'ageDays' | 'nearDupThreshold' | 'lowSignalMinAgeDays'> {
  const num = (raw: string, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    ageDays: num(SettingsDefaultsManager.get('LIGHT_MEM_COMPACT_AGE_DAYS'), 180),
    nearDupThreshold: num(SettingsDefaultsManager.get('LIGHT_MEM_COMPACT_NEAR_DUP_THRESHOLD'), 0.93),
    lowSignalMinAgeDays: num(SettingsDefaultsManager.get('LIGHT_MEM_COMPACT_LOW_SIGNAL_MIN_AGE_DAYS'), 30),
  };
}

// LocalVectorStore's unpackEmbedding is module-private; duplicate the 6-line logic.
function unpackEmbeddingLocal(blob: Uint8Array): Float32Array {
  const aligned = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

/**
 * AGE: observations older than the window, bucketed by session. A lone aged
 * observation (group size 1) has nothing to flatten against, so it is left
 * alone — pure age is not itself grounds for deletion.
 */
function selectAgeCandidates(db: Database, opts: CompactionOptions): AgeCandidate[][] {
  const cutoff = Date.now() - opts.ageDays * 86_400_000;
  const rows = db.prepare(`
    SELECT id, memory_session_id, project, type, title, subtitle, narrative,
           facts, concepts, files_read, files_modified, created_at_epoch
    FROM observations
    WHERE created_at_epoch < ?
      AND merged_into_project IS NULL
      ${opts.project ? 'AND project = ?' : ''}
    ORDER BY memory_session_id, created_at_epoch ASC
  `).all(...(opts.project ? [cutoff, opts.project] : [cutoff])) as AgeCandidate[];

  const bySession = new Map<string, AgeCandidate[]>();
  for (const r of rows) {
    const g = bySession.get(r.memory_session_id) ?? [];
    g.push(r);
    bySession.set(r.memory_session_id, g);
  }
  return [...bySession.values()].filter(g => g.length >= 2);
}

interface VectorRow { sqlite_id: number; doc_id: string; embedding: Uint8Array; project: string }

/**
 * NEAR-DUPLICATE: pairwise cosine over one representative embedding per
 * observation (narrative row if present, else text row — matching
 * ChromaSync.formatObservationDocs' own field priority). Union-find clusters
 * observations whose representative vectors are >= threshold similar.
 */
function selectNearDupClusters(db: Database, opts: CompactionOptions): number[][] {
  const rows = db.prepare(`
    SELECT sqlite_id, doc_id, embedding, project FROM vectors
    WHERE collection = ? AND doc_type = 'observation'
      AND merged_into_project IS NULL
      ${opts.project ? 'AND project = ?' : ''}
      AND (doc_id LIKE 'obs\\_%\\_narrative' ESCAPE '\\' OR doc_id LIKE 'obs\\_%\\_text' ESCAPE '\\')
    ORDER BY sqlite_id
  `).all(...(opts.project ? [VECTOR_COLLECTION, opts.project] : [VECTOR_COLLECTION])) as VectorRow[];

  const byObs = new Map<number, VectorRow>();
  for (const r of rows) {
    const existing = byObs.get(r.sqlite_id);
    if (!existing || r.doc_id.endsWith('_narrative')) byObs.set(r.sqlite_id, r); // narrative wins
  }
  let candidates = [...byObs.values()];
  if (candidates.length > opts.maxCandidateRows) {
    logger.warn('SYSTEM', 'compact: near-dup scan truncated to maxCandidateRows', {
      total: candidates.length, cap: opts.maxCandidateRows
    });
    candidates = candidates.slice(-opts.maxCandidateRows); // newest-biased
  }

  const vecs = candidates.map(c => unpackEmbeddingLocal(c.embedding));
  const n = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Never cluster across projects: a flattened replacement is filed under a
      // single project, so cross-project union would delete the other project's
      // observation with no surviving record under its own project.
      if (candidates[i].project !== candidates[j].project) continue;
      let dot = 0;
      const len = Math.min(vecs[i].length, vecs[j].length);
      for (let k = 0; k < len; k++) dot += vecs[i][k] * vecs[j][k]; // unit vectors: cosine == dot
      if (dot >= opts.nearDupThreshold) union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = clusters.get(root) ?? [];
    g.push(candidates[i].sqlite_id);
    clusters.set(root, g);
  }
  return [...clusters.values()].filter(g => g.length >= 2);
}

/**
 * LOW-SIGNAL: observations that were never retrieved or injected
 * (no observation_feedback rows), gated by a minimum age so freshly-written
 * observations aren't flagged before anyone had a chance to retrieve them.
 */
function selectLowSignalCandidates(db: Database, opts: CompactionOptions): number[] {
  // Without any retrieval/injection signal recorded, "never retrieved" is
  // indistinguishable from "not yet retrieved" — every old observation would
  // look low-signal and get deleted on the first run. Skip low-signal pruning
  // entirely until feedback has actually been accruing. Also tolerates the
  // observation_feedback table not existing on databases migrated before it
  // was introduced.
  let feedbackRows: number;
  try {
    feedbackRows = (db.prepare('SELECT COUNT(*) AS c FROM observation_feedback').get() as { c: number }).c;
  } catch {
    logger.warn('SYSTEM', 'compact: skipping low-signal pruning — observation_feedback table not present', {});
    return [];
  }
  if (feedbackRows === 0) {
    logger.warn('SYSTEM', 'compact: skipping low-signal pruning — no retrieval/injection signal recorded yet', {});
    return [];
  }

  const cutoff = Date.now() - opts.lowSignalMinAgeDays * 86_400_000;
  const rows = db.prepare(`
    SELECT o.id FROM observations o
    LEFT JOIN observation_feedback f ON f.observation_id = o.id
    WHERE o.created_at_epoch < ?
      AND o.merged_into_project IS NULL
      ${opts.project ? 'AND o.project = ?' : ''}
    GROUP BY o.id
    HAVING COUNT(f.id) = 0
    ORDER BY o.created_at_epoch ASC
  `).all(...(opts.project ? [cutoff, opts.project] : [cutoff])) as { id: number }[];
  return rows.map(r => r.id);
}

function renderClusterPrompt(group: AgeCandidate[]): string {
  const rendered = group.map((o, i) => {
    let factsStr = '';
    try { factsStr = o.facts ? (JSON.parse(o.facts) as string[]).join('; ') : ''; } catch { factsStr = ''; }
    return `### Source observation ${i + 1} (id=${o.id}, type=${o.type})\nTitle: ${o.title ?? ''}\nNarrative: ${o.narrative ?? ''}\nFacts: ${factsStr}`;
  }).join('\n\n');

  return `You are compacting old/duplicate memory records into one. Below are ${group.length} ` +
    `source observations from the same project. Merge them into ONE observation that preserves every ` +
    `distinct fact and file reference, dropping only redundant restatement.\n\n${rendered}\n\n` +
    `Respond with ONLY a JSON object matching this shape, no prose, no markdown fence:\n` +
    `{"type": "...", "title": "...", "subtitle": "...", "facts": ["..."], "narrative": "...", "concepts": ["..."], "files_read": ["..."], "files_modified": ["..."]}`;
}

/**
 * LLM flatten of one cluster. Returns null on any failure (SDK error or
 * unparseable response) — callers MUST skip the group on null and never delete
 * sources without a verified successful flatten.
 */
async function flattenObservationCluster(group: AgeCandidate[]): Promise<FlattenedObservation | null> {
  try {
    ensureDir(OBSERVER_SESSIONS_DIR);
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = resolveTierAlias(settings.LIGHT_MEM_MODEL, settings);
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const queryResult = query({
      prompt: renderClusterPrompt(group),
      options: buildHardenedSdkOptions({
        source: 'ObservationCompaction',
        project: group[0].project,
        model,
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
      }),
    });

    let answer = '';
    try {
      for await (const msg of queryResult) {
        if (msg.type === 'assistant') {
          answer = msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
        }
      }
    } catch (error) {
      if (!answer) { logger.error('SYSTEM', 'compact: flatten SDK call failed', {}, error as Error); return null; }
    }

    const cleaned = answer.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleaned);
    return {
      type: String(parsed.type ?? group[0].type),
      title: String(parsed.title ?? group[0].title ?? 'Compacted observation'),
      subtitle: parsed.subtitle ?? null,
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
      narrative: String(parsed.narrative ?? ''),
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map(String) : [],
      files_read: Array.isArray(parsed.files_read) ? parsed.files_read.map(String) : [],
      files_modified: Array.isArray(parsed.files_modified) ? parsed.files_modified.map(String) : [],
    };
  } catch (error) {
    logger.error('SYSTEM', 'compact: flatten response was not valid JSON — skipping cluster', {}, error as Error);
    return null;
  }
}

/** All vector doc_ids for one observation, regardless of fact count. */
function vectorDocIdsFor(observationId: number): string[] {
  const { ids } = LocalVectorStore.getInstance().getDocuments(VECTOR_COLLECTION, {
    where: { sqlite_id: observationId, doc_type: 'observation' },
  });
  return ids;
}

function deleteObservationAndVectors(db: Database, observationId: number): number {
  const docIds = vectorDocIdsFor(observationId);
  db.prepare('DELETE FROM observations WHERE id = ?').run(observationId);
  if (docIds.length > 0) LocalVectorStore.getInstance().deleteDocuments(VECTOR_COLLECTION, docIds);
  return docIds.length;
}

function insertFlattenedObservation(
  db: Database, memorySessionId: string, project: string, sourceIds: number[], flattened: FlattenedObservation
): number {
  const timestampEpoch = Date.now();
  const contentHash = computeObservationContentHash(memorySessionId, flattened.title, flattened.narrative);
  const row = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, content_hash, created_at, created_at_epoch, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    memorySessionId, project, flattened.type, flattened.title, flattened.subtitle,
    JSON.stringify(flattened.facts), flattened.narrative, JSON.stringify(flattened.concepts),
    JSON.stringify(flattened.files_read), JSON.stringify(flattened.files_modified),
    contentHash, new Date(timestampEpoch).toISOString(), timestampEpoch,
    JSON.stringify({ compacted_from: sourceIds })
  ) as { id: number };
  return row.id;
}

function buildVectorDocsForObservation(
  id: number, project: string, memorySessionId: string, flattened: FlattenedObservation
): AddDocument[] {
  const base: Record<string, string | number> = {
    sqlite_id: id,
    doc_type: 'observation',
    memory_session_id: memorySessionId,
    project,
    created_at_epoch: Date.now(),
    type: flattened.type,
    title: flattened.title || 'Untitled',
  };
  const docs: AddDocument[] = [];
  if (flattened.narrative) docs.push({ id: `obs_${id}_narrative`, document: flattened.narrative, metadata: { ...base, field_type: 'narrative' } });
  flattened.facts.forEach((fact, i) => docs.push({ id: `obs_${id}_fact_${i}`, document: fact, metadata: { ...base, field_type: 'fact', fact_index: i } }));
  return docs; // mirrors ChromaSync.formatObservationDocs
}

function runOneGroup(
  db: Database, kind: OutlierKind, sourceIds: number[], flattened: FlattenedObservation | null,
  memorySessionId: string, project: string, result: CompactionResult
): void {
  const groupTx = db.transaction(() => {
    let vectorRowsDeleted = 0;
    for (const id of sourceIds) vectorRowsDeleted += deleteObservationAndVectors(db, id);
    result.vectorRowsDeleted += vectorRowsDeleted;
    result.observationsDeleted += sourceIds.length;

    let newId: number | null = null;
    if (flattened) {
      newId = insertFlattenedObservation(db, memorySessionId, project, sourceIds, flattened);
      const docs = buildVectorDocsForObservation(newId, project, memorySessionId, flattened);
      LocalVectorStore.getInstance().addDocuments(VECTOR_COLLECTION, docs); // nests via SAVEPOINT
      result.vectorRowsCreated += docs.length;
      result.observationsCreated += 1;
    }

    result.groups.push({
      kind, sourceObservationIds: sourceIds, flattenedObservationId: newId,
      flattenedTitle: flattened?.title ?? '(deleted, no replacement)',
    });
  });
  groupTx();
}

function backupBeforeCompaction(sourcePath: string): string {
  const backupsDir = path.join(DATA_DIR, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `light-mem-pre-compact-${ts}.db`);
  const backupDb = new Database(sourcePath, { readonly: true });
  try {
    backupDb.run('PRAGMA busy_timeout = 5000'); // retry on lock instead of throwing when the live worker holds the DB
    backupDb.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    backupDb.close();
  }
  return backupPath;
}

/**
 * Core compaction over an already-open DB whose LocalVectorStore singleton is
 * initialized on the SAME connection. Used by the live worker route (shared
 * connection) and by {@link runCompaction} (standalone CLI).
 */
export async function runCompactionOnOpenDb(db: Database, opts: Partial<CompactionOptions> = {}): Promise<CompactionResult> {
  const settingsDefaults = defaultsFromSettings();
  const options: CompactionOptions = {
    dryRun: opts.dryRun ?? false,
    project: opts.project,
    ageDays: opts.ageDays ?? settingsDefaults.ageDays,
    nearDupThreshold: opts.nearDupThreshold ?? settingsDefaults.nearDupThreshold,
    lowSignalMinAgeDays: opts.lowSignalMinAgeDays ?? settingsDefaults.lowSignalMinAgeDays,
    maxCandidateRows: opts.maxCandidateRows ?? 2000,
    backupSourcePath: opts.backupSourcePath,
  };

  const result: CompactionResult = {
    dryRun: options.dryRun, backupPath: null, groups: [],
    observationsDeleted: 0, observationsCreated: 0, vectorRowsDeleted: 0, vectorRowsCreated: 0,
  };

  if (!options.dryRun && options.backupSourcePath) {
    result.backupPath = backupBeforeCompaction(options.backupSourcePath);
  }

  const ageGroups = selectAgeCandidates(db, options);
  const nearDupGroups = selectNearDupClusters(db, options);
  const lowSignalIds = selectLowSignalCandidates(db, options);

  // db.transaction() is synchronous; the LLM flatten is async. So each group's
  // async flatten resolves OUTSIDE any transaction, then runOneGroup() opens its
  // own small transaction for the DB writes.
  for (const group of ageGroups) {
    const flattened = await flattenObservationCluster(group);
    if (!flattened) continue;
    if (options.dryRun) {
      result.groups.push({ kind: 'age', sourceObservationIds: group.map(o => o.id), flattenedObservationId: null, flattenedTitle: flattened.title });
      continue;
    }
    runOneGroup(db, 'age', group.map(o => o.id), flattened, group[0].memory_session_id, group[0].project, result);
  }

  for (const ids of nearDupGroups) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, memory_session_id, project, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, created_at_epoch
       FROM observations WHERE id IN (${placeholders}) AND merged_into_project IS NULL`
    ).all(...ids) as AgeCandidate[];
    if (rows.length < 2) continue; // one side already deleted by an earlier group in this run
    const flattened = await flattenObservationCluster(rows);
    if (!flattened) continue;
    if (options.dryRun) {
      result.groups.push({ kind: 'near_dup', sourceObservationIds: ids, flattenedObservationId: null, flattenedTitle: flattened.title });
      continue;
    }
    runOneGroup(db, 'near_dup', ids, flattened, rows[0].memory_session_id, rows[0].project, result);
  }

  if (options.dryRun) {
    result.groups.push({ kind: 'low_signal', sourceObservationIds: lowSignalIds, flattenedObservationId: null, flattenedTitle: '(deletion only)' });
  } else if (lowSignalIds.length > 0) {
    const delTx = db.transaction(() => {
      let deletedVectors = 0;
      for (const id of lowSignalIds) deletedVectors += deleteObservationAndVectors(db, id);
      result.vectorRowsDeleted += deletedVectors;
      result.observationsDeleted += lowSignalIds.length;
    });
    delTx();
    result.groups.push({ kind: 'low_signal', sourceObservationIds: lowSignalIds, flattenedObservationId: null, flattenedTitle: '(deleted, no replacement)' });
  }

  return result;
}

/**
 * Standalone CLI entrypoint: opens its own DB + LocalVectorStore (no live worker),
 * takes a VACUUM INTO backup, runs compaction, closes.
 */
export async function runCompaction(dbPath: string, opts: Partial<CompactionOptions> = {}): Promise<CompactionResult> {
  const db = new Database(dbPath);
  db.run('PRAGMA busy_timeout = 5000'); // retry on lock instead of throwing when the live worker holds the DB
  db.run('PRAGMA foreign_keys = ON');
  if (!LocalVectorStore.hasInstance()) LocalVectorStore.init(db);
  try {
    return await runCompactionOnOpenDb(db, { ...opts, backupSourcePath: opts.backupSourcePath ?? dbPath });
  } finally {
    db.close();
  }
}
