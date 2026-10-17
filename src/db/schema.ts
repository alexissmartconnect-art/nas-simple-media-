import path from 'path';
import fs from 'fs';
import { config, type LibraryKind } from '../config';
import { hashPassword } from '../auth/passwords';
import { openDatabase, type SqliteDatabase } from './sqlite';

let db: SqliteDatabase | null = null;

/** The well-known factory password; any account still using it must change it. */
export const DEFAULT_ADMIN_PASSWORD = 'changeme';

export function getDb(): SqliteDatabase {
  if (db) return db;
  db = openDatabase(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seedDefaults(db);
  return db;
}

function initSchema(database: SqliteDatabase): void {
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
      target_type TEXT NOT NULL CHECK(target_type IN ('media','library','folder','series','artist')) DEFAULT 'media',
      media_id INTEGER,
      library_id INTEGER,
      folder_path TEXT,
      show_name TEXT,
      season INTEGER,
      artist TEXT,
      album TEXT,
      label TEXT,
      created_by INTEGER,
      password_hash TEXT,
      expires_at TEXT,
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
      FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

    CREATE TABLE IF NOT EXISTS scan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ffprobe cache: real codecs / channels / DTS-5.1 detection (Plex-like media info)
    CREATE TABLE IF NOT EXISTS media_probe (
      media_id INTEGER PRIMARY KEY,
      probe_json TEXT NOT NULL,
      mtime INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      probed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    -- Resume / On Deck (Plex-like "Continue watching")
    CREATE TABLE IF NOT EXISTS playback_progress (
      user_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      position_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, media_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON playback_progress(user_id, updated_at);

    -- Login sessions (persisted so a restart does not log everybody out).
    -- Only a SHA-256 of the cookie value is stored: a leaked DB does not leak sessions.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  migrateSharesTableIfNeeded(database);
  migrateUsersTableIfNeeded(database);
}

/** Add users.must_change_password (forced change of the default "changeme" password). */
function migrateUsersTableIfNeeded(database: SqliteDatabase): void {
  const cols = database.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'must_change_password')) {
    database.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
  }
}

function migrateSharesTableIfNeeded(database: SqliteDatabase): void {
  const cols = database.prepare(`PRAGMA table_info(shares)`).all() as Array<{ name: string }>;
  if (!cols.length) return;
  if (cols.some((c) => c.name === 'target_type')) return;

  database.pragma('foreign_keys = OFF');
  database.exec(`
    BEGIN;
    ALTER TABLE shares RENAME TO shares_legacy;
    CREATE TABLE shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      target_type TEXT NOT NULL CHECK(target_type IN ('media','library','folder','series','artist')) DEFAULT 'media',
      media_id INTEGER,
      library_id INTEGER,
      folder_path TEXT,
      show_name TEXT,
      season INTEGER,
      artist TEXT,
      album TEXT,
      label TEXT,
      created_by INTEGER,
      password_hash TEXT,
      expires_at TEXT,
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
      FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO shares (
      id, token, target_type, media_id, library_id, label,
      created_by, password_hash, expires_at, max_uses, use_count, created_at, revoked
    )
    SELECT
      s.id, s.token, 'media', s.media_id, m.library_id, m.title,
      s.created_by, s.password_hash, s.expires_at, s.max_uses, s.use_count, s.created_at, s.revoked
    FROM shares_legacy s
    LEFT JOIN media_items m ON m.id = s.media_id;
    DROP TABLE shares_legacy;
    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
    COMMIT;
  `);
  database.pragma('foreign_keys = ON');
}

function seedDefaults(database: SqliteDatabase): void {
  const admin = database.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (!admin) {
    database
      .prepare(
        `INSERT INTO users (username, password_hash, role, enabled, can_share, must_change_password)
         VALUES (?, ?, 'admin', 1, 1, ?)`
      )
      .run('admin', hashPassword(config.ADMIN_PASSWORD), config.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD ? 1 : 0);
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
  must_change_password?: number;
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

export type ShareTargetType = 'media' | 'library' | 'folder' | 'series' | 'artist';

export interface ShareRow {
  id: number;
  token: string;
  target_type: ShareTargetType;
  media_id: number | null;
  library_id: number | null;
  folder_path: string | null;
  show_name: string | null;
  season: number | null;
  artist: string | null;
  album: string | null;
  label: string | null;
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
  /** True while the account still uses the factory password: only /api/me* is allowed. */
  must_change_password?: boolean;
};

export interface MediaProbeRow {
  media_id: number;
  probe_json: string;
  mtime: number;
  size_bytes: number;
  probed_at: string;
}

export interface PlaybackProgressRow {
  user_id: number;
  media_id: number;
  position_ms: number;
  duration_ms: number;
  watched: number;
  updated_at: string;
}
