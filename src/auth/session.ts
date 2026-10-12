import crypto from 'crypto';
import { config } from '../config';
import type { SessionUser } from '../db/schema';

type SessionData = { user: SessionUser; created: number };
const sessions = new Map<string, SessionData>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [tok, s] of sessions.entries()) {
    if (now - s.created > config.SESSION_MAX_AGE_MS) {
      sessions.delete(tok);
    }
  }
}

export function createSession(user: SessionUser): string {
  pruneSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: { ...user }, created: Date.now() });
  return token;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.created > config.SESSION_MAX_AGE_MS) {
    sessions.delete(token);
    return null;
  }
  return s.user;
}

export function isValidSession(token: string | undefined): boolean {
  return getSessionUser(token) !== null;
}

/** Update live sessions when a user's role or can_share flag changes. */
export function updateUserSessions(user: SessionUser): void {
  for (const s of sessions.values()) {
    if (s.user.id === user.id) {
      s.user = { ...user };
    }
  }
}

/** Destroy all sessions for a user (e.g. after disable / password change / delete). */
export function destroyUserSessions(userId: number): void {
  for (const [tok, s] of sessions.entries()) {
    if (s.user.id === userId) sessions.delete(tok);
  }
}

/** Test helper — clear all sessions. */
export function _clearSessionsForTests(): void {
  sessions.clear();
}
