import { getDb, type MediaItem, type ShareRow, type SessionUser } from '../db/schema';
import { generateToken } from '../scanner/heuristics';
import { hashSharePassword, verifySharePassword } from '../auth/passwords';
import { config } from '../config';
import { userCanAccessLibrary } from '../libraries/libraries';

export interface CreateShareInput {
  mediaId: number;
  expiresAt?: string | null;
  maxUses?: number | null;
  password?: string | null;
  createdBy?: number | null;
}

export function createShare(input: CreateShareInput): ShareRow & { url: string } {
  const db = getDb();
  const media = db.prepare('SELECT id FROM media_items WHERE id = ?').get(input.mediaId);
  if (!media) throw new Error('Media not found');

  const token = generateToken(24);
  const password_hash = input.password ? hashSharePassword(input.password) : null;

  const info = db
    .prepare(
      `INSERT INTO shares (token, media_id, created_by, password_hash, expires_at, max_uses)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      token,
      input.mediaId,
      input.createdBy ?? null,
      password_hash,
      input.expiresAt || null,
      input.maxUses ?? null
    );

  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(info.lastInsertRowid) as ShareRow;
  return { ...row, url: `${config.PUBLIC_BASE_URL}/s/${token}` };
}

export function listShares(user: SessionUser): Array<ShareRow & { title: string; media_type: string; created_by_name: string | null }> {
  const db = getDb();
  if (user.role === 'admin') {
    return db
      .prepare(
        `SELECT s.*, m.title, m.type as media_type, u.username as created_by_name
         FROM shares s
         JOIN media_items m ON m.id = s.media_id
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.revoked = 0
         ORDER BY s.created_at DESC`
      )
      .all() as Array<ShareRow & { title: string; media_type: string; created_by_name: string | null }>;
  }
  return db
    .prepare(
      `SELECT s.*, m.title, m.type as media_type, u.username as created_by_name
       FROM shares s
       JOIN media_items m ON m.id = s.media_id
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.revoked = 0 AND s.created_by = ?
       ORDER BY s.created_at DESC`
    )
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

export type ShareAccess =
  | { ok: true; share: ShareRow; media: MediaItem; needsPassword: false }
  | { ok: true; share: ShareRow; media: MediaItem; needsPassword: true }
  | { ok: false; reason: string };

export function resolveShare(token: string, password?: string): ShareAccess {
  const db = getDb();
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRow | undefined;
  if (!share) return { ok: false, reason: 'Lien introuvable' };
  if (share.revoked) return { ok: false, reason: 'Lien révoqué' };
  if (share.expires_at) {
    const exp = Date.parse(share.expires_at);
    if (!Number.isNaN(exp) && Date.now() > exp) return { ok: false, reason: 'Lien expiré' };
  }
  if (share.max_uses != null && share.use_count >= share.max_uses) {
    return { ok: false, reason: "Nombre d'utilisations atteint" };
  }

  const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(share.media_id) as MediaItem | undefined;
  if (!media) return { ok: false, reason: 'Média introuvable' };

  if (share.password_hash) {
    if (!password) return { ok: true, share, media, needsPassword: true };
    if (!verifySharePassword(password, share.password_hash)) {
      return { ok: false, reason: 'Mot de passe incorrect' };
    }
  }

  return { ok: true, share, media, needsPassword: false };
}

export function incrementShareUse(token: string): void {
  getDb().prepare('UPDATE shares SET use_count = use_count + 1 WHERE token = ?').run(token);
}

export function assertCanShareMedia(user: SessionUser, mediaId: number): MediaItem {
  if (!user.can_share && user.role !== 'admin') {
    throw new Error('Partage non autorisé pour ce compte');
  }
  const media = getDb().prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as MediaItem | undefined;
  if (!media) throw new Error('Média introuvable');
  if (!userCanAccessLibrary(user, media.library_id)) {
    throw new Error('Accès refusé à cette bibliothèque');
  }
  return media;
}
