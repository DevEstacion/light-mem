/**
 * bun:sqlite-compatible Database adapter over Node's built-in `node:sqlite`.
 *
 * light-mem runs entirely under Node 24+ (where `node:sqlite` is available
 * unflagged) — no native module, no extra runtime, no Bun. This adapter
 * exposes the subset of the historical bun:sqlite surface the codebase uses:
 * the `Database` constructor with `{create, readwrite, readonly}` options,
 * `.query()` (a prepare alias), `.prepare()`, `.run()`, `.exec()`,
 * `.transaction()`, `.close()`, and statement `.get()/.all()/.run()`.
 * node:sqlite lacks `.query()` and `.transaction()`; both are shimmed here.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import { logger } from '../../utils/logger.js';

/** Mirrors the historical bun:sqlite bind-parameter value type. */
export type SQLQueryBindings =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array;

/**
 * Load `node:sqlite`. We prefer Node's purpose-built builtin loader
 * (`process.getBuiltinModule`, Node ≥ 22.3) which needs no base path; we avoid
 * a static `import 'node:sqlite'` and `createRequire(import.meta.url)` because
 * esbuild leaves `import.meta.url` undefined in some CJS bundles
 * (mcp-server.cjs). The createRequire fallback works because builtin resolution
 * ignores the base path, so any absolute path suffices.
 */
function loadNodeSqlite(): { DatabaseSync: typeof DatabaseSyncType } {
  const getBuiltin = (process as unknown as {
    getBuiltinModule?: (s: string) => { DatabaseSync: typeof DatabaseSyncType };
  }).getBuiltinModule;
  if (typeof getBuiltin === 'function') {
    return getBuiltin('node:sqlite');
  }
  const base = typeof __filename !== 'undefined' ? __filename : `${process.cwd()}/index.js`;
  return createRequire(base)('node:sqlite');
}

const { DatabaseSync } = loadNodeSqlite();
logger.debug('DB', 'SQLite backend: node:sqlite (built-in)');

interface DatabaseOptions {
  /** bun: create the file if missing (node:sqlite does this by default). */
  create?: boolean;
  /** bun: open read/write (the default). */
  readwrite?: boolean;
  /** bun: open read-only. */
  readonly?: boolean;
}

/**
 * A prepared-statement wrapper over node:sqlite's StatementSync. Normalizes the
 * `run()` return value to plain numbers (node:sqlite can return bigint).
 */
class Statement {
  private readonly stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
  }

  get(...params: any[]): any {
    return this.stmt.get(...params);
  }

  all(...params: any[]): any[] {
    return this.stmt.all(...params) as any[];
  }

  run(...params: any[]): { lastInsertRowid: number; changes: number } {
    const r = this.stmt.run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }
}

export class Database {
  private readonly db: DatabaseSyncType;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.db = new DatabaseSync(path, { open: true, readOnly: options.readonly === true });
  }

  /** bun:sqlite alias for prepare(). */
  query(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  /** Execute one or more statements with no result (DDL, PRAGMA, etc.). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * bun:sqlite's `db.run(sql, ...params)` — prepare + run in one call.
   * Returns the same `{ lastInsertRowid, changes }` shape.
   */
  run(sql: string, ...params: any[]): { lastInsertRowid: number; changes: number } {
    if (params.length === 0) {
      // No-param run() is always DDL/PRAGMA/txn-control in this codebase, and
      // such strings are frequently MULTI-STATEMENT (e.g. the schema bootstrap
      // is one big `CREATE TABLE ...; CREATE INDEX ...;` block). prepare().run()
      // executes only the FIRST statement, silently dropping the rest — so
      // route straight to exec(), which runs all statements. (Verified no
      // caller reads the return value of a no-param run().)
      this.db.exec(sql);
      return { lastInsertRowid: 0, changes: 0 };
    }
    const r = this.db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  /**
   * bun:sqlite's `db.transaction(fn)` returns a callable that runs `fn` inside
   * BEGIN/COMMIT, rolling back on throw. node:sqlite has no such helper, so we
   * shim it. Supports nested calls via SAVEPOINT so a transaction invoked
   * within another transaction does not error on a duplicate BEGIN.
   */
  transaction<Args extends any[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      const nested = this.inTransaction;
      const savepoint = `sp_${++this.savepointCounter}`;
      if (nested) {
        this.db.exec(`SAVEPOINT ${savepoint}`);
      } else {
        this.db.exec('BEGIN');
        this.inTransaction = true;
      }
      try {
        const result = fn(...args);
        if (nested) {
          this.db.exec(`RELEASE ${savepoint}`);
        } else {
          this.db.exec('COMMIT');
          this.inTransaction = false;
        }
        return result;
      } catch (error) {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } else {
          this.db.exec('ROLLBACK');
          this.inTransaction = false;
        }
        throw error;
      }
    };
  }

  private inTransaction = false;
  private savepointCounter = 0;

  close(): void {
    this.db.close();
  }
}
