import { verifyShareAccessToken } from './shareAccess';
import { getDb, type MediaItem, type ShareRow, type SessionUser, type ShareTargetType } from '../db/schema';
import { generateToken } from '../scanner/heuristics';
import { hashSharePassword, verifySharePassword } from '../auth/passwords';
import { getLibrary, userCanAccessLibrary } from '../libraries/libraries';
import { resolvePublicBaseUrl } from './qr';

export type { ShareTargetType };

export interface CreateShareInput {
  targetType?: ShareTargetType;
  mediaId?: number;
  libraryId?: number;
  folderPath?: string;
  showName?: string;
  season?: number | null;
  artist?: string;
  album?: string | null;
  label?: string | null;
  expiresAt?: string | null;
  maxUses?: number | null;
  password?: string | null;
  createdBy?: number | null;
}

const SHARE_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes per playback/download session
const activeLeases = new Map<string, number>();

function pruneLeases(now = Date.now()): void {
  if (activeLeases.size < 500) return;
  for (const [k, exp] of activeLeases.entries()) {
    if (exp <= now) activeLeases.delete(k);
  }
}

function leaseKey(token: string, clientKey: string): string {
  return `${token}::${clientKey}`;
}

export function hasShareLease(token: string, clientKey?: string): boolean {
  if (!clientKey) return false;
  const key = leaseKey(token, clientKey);
  const exp = activeLeases.get(key);
  if (!exp) return false;
  if (exp <= Date.now()) {
    activeLeases.delete(key);
    return false;
  }
  return true;
}

export function normalizeFolderPath(raw: string, allowEmpty = false): string {
  let p = String(raw || '')
    .replace(/\\/g, '/')
    .trim();
  p = p.replace(/^\/+|\/+$/g, '');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Chemin de dossier invalide');
  }
  if (!allowEmpty && !p) {
    throw new Error('Chemin de dossier requis');
  }
  return p;
}

function parseExpiresAt(raw?: string | null): string | null {
  if (!raw || !String(raw).trim()) return null;
  const parsed = Date.parse(String(raw).trim());
  if (Number.isNaN(parsed)) {
    throw new Error("Date d'expiration invalide");
  }
  return new Date(parsed).toISOString();
}

function parseMaxUses(raw?: number | null): number | null {
  if (raw == null || String(raw) === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("Le nombre d'utilisations max doit être un entier >= 1");
  }
  return n;
}

function countMedia(sql: string, params: unknown[]): number {
  return (getDb().prepare(`SELECT COUNT(*) as c FROM media_items WHERE ${sql}`).get(...params) as { c: number }).c;
}

export function createShare(input: CreateShareInput, baseUrl?: string): ShareRow & { url: string } {
  const db = getDb();
  const targetType: ShareTargetType = input.targetType || 'media';
  let mediaId: number | null = null;
  let libraryId: number | null = input.libraryId ?? null;
  let folderPath: string | null = null;
  let showName: string | null = null;
  let season: number | null = null;
  let artist: string | null = null;
  let album: string | null = null;
  let label: string | null = input.label?.trim() || null;

  if (targetType === 'media') {
    const id = Number(input.mediaId);
    if (!id) throw new Error('mediaId requis');
    const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(id) as MediaItem | undefined;
    if (!media) throw new Error('Média introuvable');
    mediaId = media.id;
    libraryId = media.library_id;
    if (!label) label = media.title;
  } else if (targetType === 'library') {
    const id = Number(input.libraryId);
    if (!id) throw new Error('libraryId requis');
    const lib = getLibrary(id);
    if (!lib) throw new Error('Bibliothèque introuvable');
    libraryId = lib.id;
    if (!label) label = lib.name;
  } else if (targetType === 'folder') {
    const id = Number(input.libraryId);
    if (!id) throw new Error('libraryId requis');
    const lib = getLibrary(id);
    if (!lib) throw new Error('Bibliothèque introuvable');
    folderPath = normalizeFolderPath(String(input.folderPath || ''));
    const n = countMedia('library_id = ? AND (rel_path = ? OR rel_path LIKE ?)', [
      id,
      folderPath,
      folderPath + '/%',
    ]);
    if (!n) throw new Error('Aucun média dans ce dossier');
    libraryId = id;
    if (!label) label = folderPath.split('/').pop() || folderPath;
  } else if (targetType === 'series') {
    const id = Number(input.libraryId);
    const name = String(input.showName || '').trim();
    if (!id || !name) throw new Error('libraryId et showName requis');
    const lib = getLibrary(id);
    if (!lib) throw new Error('Bibliothèque introuvable');
    showName = name;
    if (input.season != null && input.season !== ('' as unknown)) {
      const s = Number(input.season);
      if (!Number.isInteger(s) || s < 0) throw new Error('Saison invalide');
      season = s;
    }
    const n =
      season != null
        ? countMedia('library_id = ? AND show_name = ? AND season = ?', [id, showName, season])
        : countMedia('library_id = ? AND show_name = ?', [id, showName]);
    if (!n) throw new Error('Aucun épisode pour cette série');
    libraryId = id;
    if (!label) {
      label = season != null ? `${showName} · S${String(season).padStart(2, '0')}` : showName;
    }
  } else if (targetType === 'artist') {
    const id = Number(input.libraryId);
    const name = String(input.artist || '').trim();
    if (!id || !name) throw new Error('libraryId et artist requis');
    const lib = getLibrary(id);
    if (!lib) throw new Error('Bibliothèque introuvable');
    artist = name;
    if (input.album != null && String(input.album).trim() !== '') {
      album = String(input.album).trim();
    }
    const n = album
      ? countMedia('library_id = ? AND artist = ? AND album = ?', [id, artist, album])
      : countMedia('library_id = ? AND artist = ?', [id, artist]);
    if (!n) throw new Error('Aucune piste pour cet artiste');
    libraryId = id;
    if (!label) label = album ? `${artist} — ${album}` : artist;
  } else {
    throw new Error('Type de partage invalide');
  }

  const expiresAt = parseExpiresAt(input.expiresAt);
  const maxUses = parseMaxUses(input.maxUses);
  const token = generateToken(24);
  const password_hash = input.password ? hashSharePassword(input.password) : null;

  const info = db
    .prepare(
      `INSERT INTO shares (
         token, target_type, media_id, library_id, folder_path, show_name, season,
         artist, album, label, created_by, password_hash, expires_at, max_uses
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      token,
      targetType,
      mediaId,
      libraryId,
      folderPath,
      showName,
      season,
      artist,
      album,
      label,
      input.createdBy ?? null,
      password_hash,
      expiresAt,
      maxUses
    );

  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(info.lastInsertRowid) as ShareRow;
  const base = (baseUrl || resolvePublicBaseUrl()).replace(/\/+$/, '');
  return { ...row, url: `${base}/s/${token}` };
}

export function listShares(
  user: SessionUser
): Array<ShareRow & { title: string; media_type: string; created_by_name: string | null }> {
  const db = getDb();
  const sql = `SELECT s.*,
         COALESCE(s.label, m.title, l.name, s.token) as title,
         COALESCE(m.type, s.target_type) as media_type,
         u.username as created_by_name
       FROM shares s
       LEFT JOIN media_items m ON m.id = s.media_id
       LEFT JOIN libraries l ON l.id = s.library_id
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.revoked = 0`;
  if (user.role === 'admin') {
    return db
      .prepare(`${sql} ORDER BY s.created_at DESC`)
      .all() as Array<ShareRow & { title: string; media_type: string; created_by_name: string | null }>;
  }
  return db
    .prepare(`${sql} AND s.created_by = ? ORDER BY s.created_at DESC`)
    .all(user.id) as Array<ShareRow & { title: string; media_type: string; created_by_name: string | null }>;
}

export function revokeShare(id: number, user: SessionUser): boolean {
  const db = getDb();
  const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
  if (!share) return false;
  if (user.role !== 'admin' && share.created_by !== user.id) return false;
  const r = db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').run(id);
  return r.changes > 0;
}

function shareScopeWhere(share: ShareRow): { sql: string; params: unknown[] } {
  const type = share.target_type || 'media';
  if (type === 'media') {
    return { sql: 'id = ?', params: [share.media_id] };
  }
  if (type === 'library') {
    return { sql: 'library_id = ?', params: [share.library_id] };
  }
  if (type === 'folder') {
    const folder = share.folder_path || '';
    return {
      sql: 'library_id = ? AND (rel_path = ? OR rel_path LIKE ?)',
      params: [share.library_id, folder, folder + '/%'],
    };
  }
  if (type === 'series') {
    if (share.season != null) {
      return {
        sql: 'library_id = ? AND show_name = ? AND season = ?',
        params: [share.library_id, share.show_name, share.season],
      };
    }
    return { sql: 'library_id = ? AND show_name = ?', params: [share.library_id, share.show_name] };
  }
  if (type === 'artist') {
    if (share.album) {
      return {
        sql: 'library_id = ? AND artist = ? AND album = ?',
        params: [share.library_id, share.artist, share.album],
      };
    }
    return { sql: 'library_id = ? AND artist = ?', params: [share.library_id, share.artist] };
  }
  return { sql: '0', params: [] };
}

export function listShareItems(
  share: ShareRow,
  opts?: { q?: string; subfolder?: string }
): MediaItem[] {
  const db = getDb();
  const scope = shareScopeWhere(share);
  const where: string[] = [`(${scope.sql})`];
  const params: unknown[] = [...scope.params];

  if (opts?.subfolder) {
    const sub = normalizeFolderPath(opts.subfolder, true);
    if (sub) {
      where.push('(rel_path = ? OR rel_path LIKE ?)');
      params.push(sub, sub + '/%');
    }
  }
  if (opts?.q && opts.q.trim()) {
    const like = `%${opts.q.trim()}%`;
    where.push('(title LIKE ? OR show_name LIKE ? OR artist LIKE ? OR album LIKE ? OR filename LIKE ?)');
    params.push(like, like, like, like, like);
  }

  return db
    .prepare(
      `SELECT * FROM media_items WHERE ${where.join(' AND ')}
       ORDER BY
         CASE kind WHEN 'series' THEN show_name WHEN 'music' THEN artist ELSE title END,
         season, episode, album, track_num, title`
    )
    .all(...params) as MediaItem[];
}

export function resolveShareItem(share: ShareRow, mediaId: number): MediaItem | null {
  const id = Number(mediaId);
  if (!id) return null;
  const scope = shareScopeWhere(share);
  const item = getDb()
    .prepare(`SELECT * FROM media_items WHERE (${scope.sql}) AND id = ?`)
    .get(...scope.params, id) as MediaItem | undefined;
  return item || null;
}

export type ShareAccess =
  | {
      ok: true;
      share: ShareRow;
      media: MediaItem | null;
      items: MediaItem[];
      title: string;
      needsPassword: false;
    }
  | {
      ok: true;
      share: ShareRow;
      media: MediaItem | null;
      items: MediaItem[];
      title: string;
      needsPassword: true;
    }
  | { ok: false; reason: string; badPassword?: boolean };

/**
 * Resolve a public share. A password-protected share is unlocked either by a
 * valid signed access token (see shareAccess.ts) or by the password itself.
 */
export function resolveShare(
  token: string,
  password?: string,
  clientKey?: string,
  accessToken?: string
): ShareAccess {
  const db = getDb();
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRow | undefined;
  if (!share) return { ok: false, reason: 'Lien introuvable' };
  if (share.revoked) return { ok: false, reason: 'Lien révoqué' };
  if (share.expires_at) {
    const exp = Date.parse(share.expires_at);
    if (!Number.isNaN(exp) && Date.now() > exp) return { ok: false, reason: 'Lien expiré' };
  }
  if (share.max_uses != null && share.use_count >= share.max_uses && !hasShareLease(token, clientKey)) {
    return { ok: false, reason: "Nombre d'utilisations atteint" };
  }

  const items = listShareItems(share);
  const media = items[0] || null;
  const title = share.label || media?.title || 'Partage';

  const libId = share.library_id || media?.library_id;
  if (libId) {
    const lib = getLibrary(libId);
    if (!lib || !lib.enabled) {
      return { ok: false, reason: 'Bibliothèque désactivée' };
    }
  } else if (!media) {
    return { ok: false, reason: 'Média introuvable' };
  }

  if (share.password_hash) {
    if (accessToken && verifyShareAccessToken(token, share.password_hash, accessToken)) {
      return { ok: true, share, media, items, title, needsPassword: false };
    }
    if (!password) return { ok: true, share, media, items: [], title, needsPassword: true };
    if (!verifySharePassword(password, share.password_hash)) {
      return { ok: false, reason: 'Mot de passe incorrect', badPassword: true };
    }
  }

  return { ok: true, share, media, items, title, needsPassword: false };
}

export function incrementShareUse(token: string): void {
  getDb().prepare('UPDATE shares SET use_count = use_count + 1 WHERE token = ?').run(token);
}

/**
 * Record a share usage, deduplicating multiple HTTP Range / HLS requests from
 * the same client within a playback lease window so `max_uses=1` works with
 * HTML5 `<video>` seeking and HLS segments.
 */
export function consumeShareUse(token: string, clientKey?: string): void {
  const now = Date.now();
  pruneLeases(now);
  if (clientKey) {
    const key = leaseKey(token, clientKey);
    const exp = activeLeases.get(key);
    if (exp && exp > now) {
      activeLeases.set(key, now + SHARE_LEASE_TTL_MS);
      return;
    }
    activeLeases.set(key, now + SHARE_LEASE_TTL_MS);
  }
  incrementShareUse(token);
}

export function _clearShareLeasesForTests(): void {
  activeLeases.clear();
}

export function assertCanCreateShare(user: SessionUser, input: CreateShareInput): void {
  if (!user.can_share && user.role !== 'admin') {
    throw new Error('Partage non autorisé pour ce compte');
  }
  const targetType: ShareTargetType = input.targetType || 'media';
  let libraryId = input.libraryId != null ? Number(input.libraryId) : undefined;
  if (targetType === 'media' || input.mediaId) {
    const media = getDb()
      .prepare('SELECT * FROM media_items WHERE id = ?')
      .get(Number(input.mediaId)) as MediaItem | undefined;
    if (targetType === 'media') {
      if (!media) throw new Error('Média introuvable');
      libraryId = media.library_id;
    }
  }
  if (!libraryId) {
    throw new Error('libraryId requis');
  }
  if (!userCanAccessLibrary(user, libraryId)) {
    throw new Error('Accès refusé à cette bibliothèque');
  }
}

export function assertCanShareMedia(user: SessionUser, mediaId: number): MediaItem {
  assertCanCreateShare(user, { targetType: 'media', mediaId });
  const media = getDb().prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as
    | MediaItem
    | undefined;
  if (!media) throw new Error('Média introuvable');
  return media;
}

export interface FolderBrowseResult {
  folder: string;
  subfolders: Array<{ name: string; path: string; item_count: number }>;
  items: MediaItem[];
  total_in_tree: number;
}

export function browseLibraryFolder(libraryId: number, parentFolder = ''): FolderBrowseResult {
  const parent = normalizeFolderPath(parentFolder, true);
  const db = getDb();
  const all = db
    .prepare(
      `SELECT * FROM media_items WHERE library_id = ?
       ORDER BY rel_path, season, episode, album, track_num, title`
    )
    .all(libraryId) as MediaItem[];

  const prefix = parent ? parent + '/' : '';
  const subfolderNames = new Set<string>();
  const directItems: MediaItem[] = [];
  let total_in_tree = 0;

  for (const it of all) {
    const rel = String(it.rel_path || '').replace(/\\/g, '/');
    if (parent) {
      if (rel !== parent && !rel.startsWith(prefix)) continue;
    }
    total_in_tree += 1;
    if (parent && rel === parent) {
      directItems.push(it);
      continue;
    }
    const rest = parent ? rel.slice(prefix.length) : rel;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      directItems.push(it);
    } else {
      subfolderNames.add(rest.slice(0, slash));
    }
  }

  const subfolders = [...subfolderNames].sort().map((name) => {
    const folderPath = parent ? `${parent}/${name}` : name;
    const item_count = all.filter((it) => {
      const rel = String(it.rel_path || '').replace(/\\/g, '/');
      return rel === folderPath || rel.startsWith(folderPath + '/');
    }).length;
    return { name, path: folderPath, item_count };
  });

  return { folder: parent, subfolders, items: directItems, total_in_tree };
}
