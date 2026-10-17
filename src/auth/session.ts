import crypto from 'crypto';
import { config } from '../config';
import { getDb, type SessionUser } from '../db/schema';

/**
 * Login sessions, persisted in SQLite (table `sessions`).
 * The cookie carries a random 256-bit token; only its SHA-256 is stored.
 * Sessions expire after SESSION_MAX_AGE_MS, are deleted on logout, and all
 * sessions of a user are deleted on disable / delete / password change.
 * The user record is re-read on every lookup, so role / can_share changes
 * apply immediately and disabled accounts are rejected.
 */

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

let lastPrune = 0;
function pruneSessions(force = false): void {
  const now = Date.now();
  if (!force && now - lastPrune < 60_000) return;
  lastPrune = now;
  getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export function createSession(user: SessionUser, meta: SessionMeta = {}): string {
  pruneSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      hashToken(token),
      user.id,
      now,
      now + config.SESSION_MAX_AGE_MS,
      (meta.ip || '').slice(0, 64) || null,
      (meta.userAgent || '').slice(0, 200) || null
    );
  return token;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  const row = getDb()
    .prepare(
      `SELECT s.expires_at, u.id, u.username, u.role, u.enabled, u.can_share, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(hashToken(token)) as
    | {
        expires_at: number;
        id: number;
        username: string;
        role: 'admin' | 'user';
        enabled: number;
        can_share: number;
        must_change_password: number | null;
      }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now() || !row.enabled) {
    destroySession(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    can_share: !!row.can_share,
    must_change_password: !!row.must_change_password,
  };
}

export function isValidSession(token: string | undefined): boolean {
  return getSessionUser(token) !== null;
}

/**
 * Kept for API compatibility: sessions read the user row on every request,
 * so role / can_share changes already apply immediately.
 */
export function updateUserSessions(_user: SessionUser): void {
  // no-op
}

/** Destroy all sessions for a user (disable / delete / password change). */
export function destroyUserSessions(userId: number, exceptToken?: string): void {
  if (exceptToken) {
    getDb()
      .prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`)
      .run(userId, hashToken(exceptToken));
  } else {
    getDb().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  }
}

/** Number of live sessions for a user (tests / diagnostics). */
export function countUserSessions(userId: number): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?`)
    .get(userId, Date.now()) as { c: number };
  return r.c;
}

/** Test helper — clear all sessions. */
export function _clearSessionsForTests(): void {
  getDb().prepare(`DELETE FROM sessions`).run();
  lastPrune = 0;
}

/** Test helper — force-expire every session. */
export function _expireSessionsForTests(): void {
  getDb().prepare(`UPDATE sessions SET expires_at = ?`).run(Date.now() - 1);
}
