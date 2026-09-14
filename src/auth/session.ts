import crypto from 'crypto';
import { config } from '../config';
import type { SessionUser } from '../db/schema';

type SessionData = { user: SessionUser; created: number };
const sessions = new Map<string, SessionData>();

export function createSession(user: SessionUser): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, created: Date.now() });
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

/** Destroy all sessions for a user (e.g. after disable / password change). */
export function destroyUserSessions(userId: number): void {
  for (const [tok, s] of sessions.entries()) {
    if (s.user.id === userId) sessions.delete(tok);
  }
}
