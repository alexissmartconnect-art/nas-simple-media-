import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config, type LibraryKind } from '../config';
import { hashPassword } from '../auth/passwords';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seedDefaults(db);
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1,
      can_share INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('movies','series','music')),
      path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS library_access (
      user_id INTEGER NOT NULL,
      library_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, library_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('movie','episode','track')),
      kind TEXT NOT NULL CHECK(kind IN ('movies','series','music')),
      show_name TEXT,
      season INTEGER,
      episode INTEGER,
      artist TEXT,
      album TEXT,
      track_num INTEGER,
      duration_hint INTEGER,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(library_id, rel_path),
      FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_library_id ON media_items(library_id);
    CREATE INDEX IF NOT EXISTS idx_media_kind ON media_items(kind);
    CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
    CREATE INDEX IF NOT EXISTS idx_media_show ON media_items(show_name);
    CREATE INDEX IF NOT EXISTS idx_media_artist ON media_items(artist);
    CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(title);

    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      media_id INTEGER NOT NULL,
      created_by INTEGER,
      password_hash TEXT,
      expires_at TEXT,
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

    CREATE TABLE IF NOT EXISTS scan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seedDefaults(database: Database.Database): void {
  const admin = database.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (!admin) {
    database
      .prepare(
        `INSERT INTO users (username, password_hash, role, enabled, can_share)
         VALUES (?, ?, 'admin', 1, 1)`
      )
      .run('admin', hashPassword(config.ADMIN_PASSWORD));
  }

  const libCount = (database.prepare(`SELECT COUNT(*) as c FROM libraries`).get() as { c: number }).c;
  if (libCount === 0) {
    const defaults: Array<{ name: string; type: LibraryKind; folder: string }> = [
      { name: 'Films', type: 'movies', folder: 'Movies' },
      { name: 'Séries', type: 'series', folder: 'Series' },
      { name: 'Musique', type: 'music', folder: 'Music' },
    ];
    const insert = database.prepare(
      `INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)`
    );
    for (const d of defaults) {
      const abs = path.join(config.MEDIA_PATH, d.folder);
      try {
        fs.mkdirSync(abs, { recursive: true });
      } catch {
        /* ignore */
      }
      insert.run(d.name, d.type, d.folder);
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  enabled: number;
  can_share: number;
  created_at: string;
  updated_at: string;
}

export interface LibraryRow {
  id: number;
  name: string;
  type: LibraryKind;
  path: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MediaItem {
  id: number;
  library_id: number;
  path: string;
  rel_path: string;
  filename: string;
  title: string;
  type: 'movie' | 'episode' | 'track';
  kind: LibraryKind;
  show_name: string | null;
  season: number | null;
  episode: number | null;
  artist: string | null;
  album: string | null;
  track_num: number | null;
  duration_hint: number | null;
  size_bytes: number;
  mtime: number;
  created_at: string;
  updated_at: string;
}

export interface ShareRow {
  id: number;
  token: string;
  media_id: number;
  created_by: number | null;
  password_hash: string | null;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  created_at: string;
  revoked: number;
}

export type SessionUser = {
  id: number;
  username: string;
  role: 'admin' | 'user';
  can_share: boolean;
};
