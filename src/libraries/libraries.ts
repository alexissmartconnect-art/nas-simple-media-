import fs from 'fs';
import path from 'path';
import { config, type LibraryKind } from '../config';
import { getDb, type LibraryRow, type SessionUser } from '../db/schema';
import { getUserLibraryIds } from '../users/users';

const FORBIDDEN_SYSTEM_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/boot',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
];

export function resolveLibraryPath(libPath: string): string {
  if (path.isAbsolute(libPath)) return path.resolve(libPath);
  return path.resolve(config.MEDIA_PATH, libPath);
}

export function validateLibraryPath(rawPath: string): string {
  const libPath = rawPath.trim();
  if (!libPath) throw new Error('Chemin requis');

  const abs = resolveLibraryPath(libPath);
  const mediaRoot = path.resolve(config.MEDIA_PATH);
  const dataRoot = path.resolve(config.DATA_PATH);

  if (!path.isAbsolute(libPath)) {
    if (!abs.startsWith(mediaRoot + path.sep) && abs !== mediaRoot) {
      throw new Error('Le chemin doit être sous MEDIA_PATH');
    }
  }

  if (abs === '/' || abs === dataRoot || abs.startsWith(dataRoot + path.sep)) {
    throw new Error('Chemin interdit');
  }

  for (const prefix of FORBIDDEN_SYSTEM_PREFIXES) {
    if (abs === prefix || abs.startsWith(prefix + path.sep)) {
      throw new Error('Chemin système interdit');
    }
  }

  return abs;
}

export function listAllLibraries(): LibraryRow[] {
  return getDb().prepare(`SELECT * FROM libraries ORDER BY name`).all() as LibraryRow[];
}

export function listLibrariesForUser(user: SessionUser): LibraryRow[] {
  if (user.role === 'admin') {
    return listAllLibraries().filter((l) => l.enabled);
  }
  const ids = getUserLibraryIds(user.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT * FROM libraries WHERE enabled = 1 AND id IN (${placeholders}) ORDER BY name`
    )
    .all(...ids) as LibraryRow[];
}

export function getLibrary(id: number): LibraryRow | undefined {
  return getDb().prepare(`SELECT * FROM libraries WHERE id = ?`).get(id) as LibraryRow | undefined;
}

export function userCanAccessLibrary(user: SessionUser, libraryId: number): boolean {
  const lib = getLibrary(libraryId);
  if (!lib || !lib.enabled) return false;
  if (user.role === 'admin') return true;
  return getUserLibraryIds(user.id).includes(libraryId);
}

export function createLibrary(input: { name: string; type: LibraryKind; path: string }) {
  const name = input.name.trim();
  if (!name) throw new Error('Nom requis');
  if (!['movies', 'series', 'music'].includes(input.type)) throw new Error('Type invalide');
  const libPath = input.path.trim();
  const abs = validateLibraryPath(libPath);

  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch {
    /* may be read-only mount */
  }

  try {
    const info = getDb()
      .prepare(`INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)`)
      .run(name, input.type, libPath);
    return getLibrary(Number(info.lastInsertRowid))!;
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) throw new Error('Nom de bibliothèque déjà utilisé');
    throw e;
  }
}

export function updateLibrary(
  id: number,
  patch: { name?: string; path?: string; enabled?: boolean }
) {
  const lib = getLibrary(id);
  if (!lib) throw new Error('Bibliothèque introuvable');
  const name = patch.name?.trim() || lib.name;
  const libPath = patch.path?.trim() || lib.path;
  if (patch.path !== undefined) {
    validateLibraryPath(libPath);
  }
  try {
    getDb()
      .prepare(
        `UPDATE libraries SET name = ?, path = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(name, libPath, patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : lib.enabled, id);
    return getLibrary(id)!;
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) throw new Error('Nom de bibliothèque déjà utilisé');
    throw e;
  }
}

export function deleteLibrary(id: number): boolean {
  const r = getDb().prepare(`DELETE FROM libraries WHERE id = ?`).run(id);
  return r.changes > 0;
}

export function getLibraryAccessMap(): Record<number, number[]> {
  const rows = getDb()
    .prepare(`SELECT user_id, library_id FROM library_access`)
    .all() as { user_id: number; library_id: number }[];
  const map: Record<number, number[]> = {};
  for (const r of rows) {
    if (!map[r.user_id]) map[r.user_id] = [];
    map[r.user_id].push(r.library_id);
  }
  return map;
}

export function libraryWithStats(lib: LibraryRow) {
  const count = (
    getDb().prepare(`SELECT COUNT(*) as c FROM media_items WHERE library_id = ?`).get(lib.id) as {
      c: number;
    }
  ).c;
  return {
    ...lib,
    enabled: !!lib.enabled,
    item_count: count,
    resolved_path: resolveLibraryPath(lib.path),
  };
}
