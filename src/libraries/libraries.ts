import fs from 'fs';
import path from 'path';
import { config, type LibraryKind } from '../config';
import { getDb, type LibraryRow, type SessionUser } from '../db/schema';
import { getUserLibraryIds } from '../users/users';

export const FORBIDDEN_SYSTEM_PREFIXES = [
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

/** Shared folders of /volume1 referenced by their DSM / File Station alias. */
const SHARE_ALIAS_VOLUME1 = ['video', 'music', 'photo', 'surveillance', 'web', 'homes'];

/**
 * Translate a Synology File Station style path into the real mount path(s).
 *
 * DSM File Station shows USB drives as `/usbshare1`, `/usbshare1-2`, … while the
 * Linux mount point is `/volumeUSB<n>/usbshare<n>` (classic layout) or
 * `/volumeUSB<n>/usbshare<n>-<m>` (multi-partition layout). Shared folders are
 * shown as `/video`, `/music`, `/photo` instead of `/volume1/video`, …
 *
 * Returns candidates in priority order (first match that exists on disk wins).
 */
export function synologyPathCandidates(rawPath: string): string[] {
  const cleaned = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (!cleaned.startsWith('/')) return [];
  const withoutTrailing = cleaned.replace(/\/+$/, '') || '/';

  // /usbshare1-2/Films — the number before the dash is the USB volume index.
  const usbDash = /^\/usbshare(\d+)-(\d+)(\/.*)?$/.exec(withoutTrailing);
  if (usbDash) {
    const volume = Number(usbDash[1]);
    const share = `usbshare${usbDash[1]}-${usbDash[2]}`;
    const rest = usbDash[3] || '';
    return dedupe([
      `/volumeUSB${volume}/${share}${rest}`,
      `/volumeUSB${volume}/usbshare${usbDash[2]}${rest}`,
      `/volumeUSB1/${share}${rest}`,
    ]);
  }

  // /usbshare2/Films — plain USB share number. `/volumeUSB2/usbshare` is the
  // classic DSM mount point, `/volumeUSB2/usbshare2` the DSM 7 one: both are
  // probed on disk, the classic layout being the fallback (single USB drive).
  const usbPlain = /^\/usbshare(\d+)(\/.*)?$/.exec(withoutTrailing);
  if (usbPlain) {
    const n = Number(usbPlain[1]);
    const rest = usbPlain[2] || '';
    return dedupe([
      `/volumeUSB${n}/usbshare${rest}`,
      `/volumeUSB${n}/usbshare${n}${rest}`,
      `/volumeUSB1/usbshare${rest}`,
      `/volumeUSB1/usbshare${n}${rest}`,
    ]);
  }

  // /usbshare/Films — single USB drive, classic DSM mount point.
  const usbBare = /^\/usbshare(\/.*)?$/.exec(withoutTrailing);
  if (usbBare) {
    const rest = usbBare[1] || '';
    return dedupe([`/volumeUSB1/usbshare${rest}`, `/volumeUSB1/usbshare1${rest}`]);
  }

  // /volumeUSB3/Films — volume without the usbshare child (DSM sometimes hides it).
  const usbVolume = /^\/volumeUSB(\d+)(\/.*)?$/.exec(withoutTrailing);
  if (usbVolume) {
    const rest = usbVolume[2] || '';
    if (!rest) return [];
    return dedupe([`/volumeUSB${usbVolume[1]}${rest}`, `/volumeUSB${usbVolume[1]}/usbshare${rest}`]);
  }

  // /video/Films → /volume1/video/Films (shared folders of the main volume).
  const shareAlias = /^\/([a-zA-Z0-9_-]+)(\/.*)?$/.exec(withoutTrailing);
  if (shareAlias && SHARE_ALIAS_VOLUME1.includes(shareAlias[1].toLowerCase())) {
    return [`/volume1/${shareAlias[1]}${shareAlias[2] || ''}`];
  }

  return [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve a File Station style path to an existing mount, falling back to the
 * canonical candidate when nothing is mounted yet (so the path stays stable).
 */
export function resolveSynologyAlias(rawPath: string): string | null {
  const candidates = synologyPathCandidates(rawPath);
  if (!candidates.length) return null;
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch {
      /* not mounted (or not reachable) — try the next candidate */
    }
  }
  return path.resolve(candidates[0]);
}

/**
 * Resolve a library path:
 * 1. an existing absolute path is used as-is (Docker mounts like /media, /music…),
 * 2. otherwise Synology File Station aliases (`/usbshare1`, `/video`…) are
 *    translated to their real mount points,
 * 3. relative paths live under MEDIA_PATH, anything else absolute is used as-is.
 */
export function resolveLibraryPath(libPath: string): string {
  const raw = String(libPath ?? '').trim();
  if (path.isAbsolute(raw)) {
    const direct = path.resolve(raw);
    try {
      if (fs.statSync(direct).isDirectory()) return direct;
    } catch {
      /* not mounted: fall through to the Synology alias resolution */
    }
  }
  const alias = resolveSynologyAlias(raw);
  if (alias) return alias;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(config.MEDIA_PATH, raw);
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
