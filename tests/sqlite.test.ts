import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openDatabase,
  activeBackend,
  type SqliteDatabase,
  type SqliteRunResult,
} from '../src/db/sqlite';

const SCHEMA = `
  CREATE TABLE t (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    n INTEGER
  );
`;

function open(path: string): SqliteDatabase {
  return openDatabase(path);
}

describe('sqlite driver adapter', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-sqlite-'));
    delete process.env.NAS_SM_SQLITE_BACKEND;
  });

  afterEach(() => {
    delete process.env.NAS_SM_SQLITE_BACKEND;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers the built-in node:sqlite engine when available', () => {
    if (!hasNodeSqlite()) return;
    const db = open(path.join(tmp, 'a.db'));
    assert.equal(db.backend, 'node:sqlite');
    db.close();
  });

  it('supports prepare/run/get/all and reports changes + lastInsertRowid', () => {
    const db = open(path.join(tmp, 'b.db'));
    try {
      db.exec(SCHEMA);
      const ins = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)');
      const r: SqliteRunResult = ins.run('alpha', 1);
      assert.equal(r.changes, 1);
      assert.equal(Number(r.lastInsertRowid), 1);

      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 1);
      const rows = db.prepare('SELECT name FROM t ORDER BY id').all() as Array<{ name: string }>;
      assert.deepEqual(rows.map((x) => x.name), ['alpha']);
      assert.equal(db.prepare('SELECT * FROM t WHERE id = ?').get(999), undefined);
    } finally {
      db.close();
    }
  });

  it('runs multi-statement exec blocks', () => {
    const db = open(path.join(tmp, 'c.db'));
    try {
      db.exec(`
        CREATE TABLE a (x INTEGER);
        CREATE TABLE b (y TEXT);
        INSERT INTO a VALUES (1);
        INSERT INTO b VALUES ('ok');
      `);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM a').get().c, 1);
      assert.equal(db.prepare('SELECT y FROM b').get().y, 'ok');
    } finally {
      db.close();
    }
  });

  it('applies pragma statements', () => {
    const db = open(path.join(tmp, 'd.db'));
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      // No throw means the pragma was accepted.
      assert.ok(true);
    } finally {
      db.close();
    }
  });

  it('commits a transaction and rolls back on throw', () => {
    const db = open(path.join(tmp, 'e.db'));
    try {
      db.exec(SCHEMA);
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('kept');
        return 'returned';
      });
      assert.equal(tx(), 'returned');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 1);

      const failing = db.transaction(() => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('lost');
        throw new Error('boom');
      });
      assert.throws(failing, /boom/);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 1);
    } finally {
      db.close();
    }
  });

  it('persists data across reopen', () => {
    const file = path.join(tmp, 'f.db');
    const first = open(file);
    first.exec(SCHEMA);
    first.prepare('INSERT INTO t (name) VALUES (?)').run('persisted');
    first.close();

    const second = open(file);
    try {
      assert.equal(second.prepare('SELECT name FROM t').get().name, 'persisted');
    } finally {
      second.close();
    }
  });

  it('can be pinned to better-sqlite3 via NAS_SM_SQLITE_BACKEND', () => {
    process.env.NAS_SM_SQLITE_BACKEND = 'better-sqlite3';
    assert.equal(activeBackend(), 'better-sqlite3');
    const db = open(path.join(tmp, 'g.db'));
    try {
      assert.equal(db.backend, 'better-sqlite3');
      db.exec(SCHEMA);
      db.transaction(() => db.prepare('INSERT INTO t (name) VALUES (?)').run('pinned'))();
      assert.equal(db.prepare('SELECT name FROM t').get().name, 'pinned');
    } finally {
      db.close();
    }
  });

  it('exposes a consistent activeBackend()', () => {
    assert.ok(['node:sqlite', 'better-sqlite3'].includes(activeBackend()));
  });
});

function hasNodeSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
