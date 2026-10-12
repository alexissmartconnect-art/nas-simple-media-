/**
 * SQLite driver abstraction.
 *
 * Two interchangeable backends are supported:
 *
 *  1. `node:sqlite` (`DatabaseSync`) — the SQLite engine built into Node.js.
 *     Available from Node 22.5.0. Chosen by default because it needs **no
 *     native compilation**, which is what makes the Synology DSM 7 SPK
 *     installable: DSM ships glibc 2.26, far older than the toolchain used to
 *     build `better-sqlite3` prebuilt binaries.
 *
 *  2. `better-sqlite3` — the original native addon, kept as a fallback for
 *     runtimes without `node:sqlite` (Node < 22.5, e.g. the Docker image).
 *
 * Both expose the same synchronous subset used by this application:
 * `prepare().run()/get()/all()`, `exec()`, `pragma()` and `close()`.
 */

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Mirrors `better-sqlite3`'s `db.pragma('journal_mode = WAL')`. */
  pragma(statement: string): unknown;
  /**
   * Wraps `fn` in BEGIN/COMMIT, rolling back on throw — same contract as
   * `better-sqlite3`'s `db.transaction(fn)`.
   */
  transaction<T>(fn: () => T): () => T;
  close(): void;
  /** Which backend is actually in use. */
  readonly backend: 'node:sqlite' | 'better-sqlite3';
}

/** BEGIN/COMMIT wrapper shared by both backends. */
function makeTransaction(db: {
  exec(sql: string): void;
}): <T>(fn: () => T) => () => T {
  return <T>(fn: () => T) => () => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rollback best effort */
      }
      throw err;
    }
  };
}

/** `node:sqlite` refuses `undefined`; SQLite has no undefined, so map it to NULL. */
function normalize(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

function toNumber(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type NodeSqliteModule = {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => {
    prepare(sql: string): {
      run(...params: unknown[]): { changes: unknown; lastInsertRowid: unknown };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    exec(sql: string): void;
    close(): void;
  };
};

function loadNodeSqlite(): NodeSqliteModule | null {
  // The experimental notice fires as soon as the module is required, so the
  // filter has to be in place before that happens.
  silenceSqliteWarning();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as NodeSqliteModule;
    return mod && typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    return null;
  }
}

let warningFilterInstalled = false;

/**
 * `node:sqlite` is flagged experimental and emits a one-shot warning the first
 * time the engine is actually used (not when the module is required). Silence
 * just that warning so NAS service logs stay clean; the choice of backend is
 * reported explicitly through `activeBackend()` instead.
 */
function silenceSqliteWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;

  const original = process.emitWarning;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emitWarning = function patched(warning: unknown, ...rest: unknown[]): void {
    // Node calls emitWarning(warning, type) as well as emitWarning(warning, { type }).
    const second = rest[0];
    const type = typeof second === 'string' ? second : (second as { type?: string })?.type;
    const message = typeof warning === 'string' ? warning : String(warning);
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
}

function openNodeSqlite(path: string): SqliteDatabase | null {
  const mod = loadNodeSqlite();
  if (!mod) return null;

  let handle: InstanceType<NodeSqliteModule['DatabaseSync']>;
  try {
    handle = new mod.DatabaseSync(path);
  } catch {
    // Newer Node versions accept an options object instead of a bare path.
    try {
      handle = new mod.DatabaseSync(path, { location: path });
    } catch {
      return null;
    }
  }

  return {
    backend: 'node:sqlite',
    prepare(sql: string): SqliteStatement {
      const stmt = handle.prepare(sql);
      return {
        run: (...params: unknown[]): SqliteRunResult => {
          const r = stmt.run(...normalize(params));
          return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) };
        },
        get: (...params: unknown[]): unknown => stmt.get(...normalize(params)),
        all: (...params: unknown[]): unknown[] => stmt.all(...normalize(params)),
      };
    },
    exec(sql: string): void {
      handle.exec(sql);
    },
    pragma(statement: string): unknown {
      // `DatabaseSync` has no `pragma()` helper; PRAGMA is just SQL.
      handle.exec(`PRAGMA ${statement}`);
      return undefined;
    },
    transaction: makeTransaction(handle),
    close(): void {
      try {
        handle.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function openBetterSqlite3(path: string): SqliteDatabase {
  // Imported lazily so that runtimes using `node:sqlite` never load the addon.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const handle = new BetterSqlite3(path);

  return {
    backend: 'better-sqlite3',
    prepare(sql: string): SqliteStatement {
      const stmt = handle.prepare(sql);
      return {
        run: (...params: unknown[]): SqliteRunResult => {
          const r = stmt.run(...(params as never[]));
          return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) };
        },
        get: (...params: unknown[]): unknown => stmt.get(...(params as never[])),
        all: (...params: unknown[]): unknown[] => stmt.all(...(params as never[])) as unknown[],
      };
    },
    exec(sql: string): void {
      handle.exec(sql);
    },
    pragma(statement: string): unknown {
      return handle.pragma(statement);
    },
    transaction: makeTransaction(handle),
    close(): void {
      handle.close();
    },
  };
}

/**
 * Optional operator override, e.g. `NAS_SM_SQLITE_BACKEND=better-sqlite3`.
 * Handy on the NAS to pin a backend when diagnosing an install.
 */
function preferredBackend(): SqliteDatabase['backend'] | null {
  const v = (process.env.NAS_SM_SQLITE_BACKEND || '').trim().toLowerCase();
  if (v === 'better-sqlite3' || v === 'node:sqlite') return v;
  return null;
}

/**
 * Open (or create) a SQLite database, preferring the built-in `node:sqlite`.
 */
export function openDatabase(path: string): SqliteDatabase {
  if (preferredBackend() !== 'better-sqlite3') {
    const builtin = openNodeSqlite(path);
    if (builtin) return builtin;
  }
  return openBetterSqlite3(path);
}

export function activeBackend(): SqliteDatabase['backend'] {
  if (preferredBackend() === 'better-sqlite3') return 'better-sqlite3';
  return loadNodeSqlite() ? 'node:sqlite' : 'better-sqlite3';
}
