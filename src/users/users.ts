import { getDb, type UserRow, type SessionUser } from '../db/schema';
import { config } from '../config';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { destroyUserSessions, updateUserSessions } from '../auth/session';
import { revokeUserStreamTokens } from '../auth/streamTokens';

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    enabled: !!u.enabled,
    can_share: !!u.can_share,
    created_at: u.created_at,
  };
}

export function authenticate(username: string, password: string): SessionUser | null {
  const db = getDb();
  const u = db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(username.trim()) as UserRow | undefined;
  if (!u || !u.enabled) return null;
  if (!verifyPassword(password, u.password_hash)) return null;
  return { id: u.id, username: u.username, role: u.role, can_share: !!u.can_share };
}

export function listUsers() {
  return (getDb().prepare(`SELECT * FROM users ORDER BY username`).all() as UserRow[]).map(publicUser);
}

export function getUser(id: number): UserRow | undefined {
  return getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function createUser(input: {
  username: string;
  password: string;
  role?: 'admin' | 'user';
  can_share?: boolean;
}) {
  const username = input.username.trim();
  if (!username || username.length < 2) throw new Error("Nom d'utilisateur trop court");
  if (!input.password || input.password.length < 4) throw new Error('Mot de passe trop court (min 4)');
  const db = getDb();
  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, can_share)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        username,
        hashPassword(input.password),
        input.role || 'user',
        input.can_share === false ? 0 : 1
      );
    return publicUser(getUser(Number(info.lastInsertRowid))!);
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE')) throw new Error("Nom d'utilisateur déjà pris");
    throw e;
  }
}

export function updateUser(
  id: number,
  patch: {
    password?: string;
    role?: 'admin' | 'user';
    enabled?: boolean;
    can_share?: boolean;
  }
) {
  const db = getDb();
  const u = getUser(id);
  if (!u) throw new Error('Utilisateur introuvable');

  if (patch.password !== undefined && patch.password !== '' && patch.password.length < 4) {
    throw new Error('Mot de passe trop court (min 4)');
  }

  if (patch.enabled === false && u.role === 'admin') {
    const admins = (
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1`).get() as {
        c: number;
      }
    ).c;
    if (admins <= 1) throw new Error('Impossible de désactiver le dernier admin');
  }
  if (patch.role === 'user' && u.role === 'admin') {
    const admins = (
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1`).get() as {
        c: number;
      }
    ).c;
    if (admins <= 1) throw new Error('Impossible de rétrograder le dernier admin');
  }

  const password_hash = patch.password ? hashPassword(patch.password) : u.password_hash;
  db.prepare(
    `UPDATE users SET
      password_hash = ?,
      role = ?,
      enabled = ?,
      can_share = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    password_hash,
    patch.role ?? u.role,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : u.enabled,
    patch.can_share !== undefined ? (patch.can_share ? 1 : 0) : u.can_share,
    id
  );

  const updated = publicUser(getUser(id)!);
  if (patch.password || patch.enabled === false) {
    destroyUserSessions(id);
    revokeUserStreamTokens(id);
  } else {
    updateUserSessions({
      id: updated.id,
      username: updated.username,
      role: updated.role,
      can_share: updated.can_share,
    });
  }
  return updated;
}

export function deleteUser(id: number, actorId?: number): boolean {
  const db = getDb();
  const u = getUser(id);
  if (!u) return false;
  if (actorId !== undefined && actorId === id) {
    throw new Error('Impossible de supprimer votre propre compte');
  }
  if (u.role === 'admin' && u.enabled) {
    const admins = (
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1`).get() as {
        c: number;
      }
    ).c;
    if (admins <= 1) throw new Error('Impossible de supprimer le dernier admin');
  }
  destroyUserSessions(id);
  revokeUserStreamTokens(id);
  const r = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  return r.changes > 0;
}

export function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): void {
  const u = getUser(userId);
  if (!u || !u.enabled) throw new Error('Utilisateur introuvable');
  if (!verifyPassword(currentPassword, u.password_hash)) {
    throw new Error('Mot de passe actuel incorrect');
  }
  if (!newPassword || newPassword.length < 4) {
    throw new Error('Nouveau mot de passe trop court (min 4)');
  }
  getDb()
    .prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(newPassword), userId);
}

export function setUserLibraries(userId: number, libraryIds: number[]): void {
  const db = getDb();
  if (!getUser(userId)) throw new Error('Utilisateur introuvable');
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM library_access WHERE user_id = ?`).run(userId);
    const ins = db.prepare(`INSERT INTO library_access (user_id, library_id) VALUES (?, ?)`);
    for (const lid of libraryIds) {
      const lib = db.prepare(`SELECT id FROM libraries WHERE id = ?`).get(lid);
      if (lib) ins.run(userId, lid);
    }
  });
  tx();
}

/**
 * True while the seeded `admin` account still uses an installation default
 * password (`changeme`, or `ADMIN_PASSWORD`). The login page shows a discreet
 * hint so the very first connection is easy, and it disappears as soon as the
 * password is changed.
 */
export function isDefaultAdminPasswordActive(): boolean {
  try {
    const db = getDb();
    const u = db
      .prepare(`SELECT * FROM users WHERE username = 'admin' COLLATE NOCASE`)
      .get() as UserRow | undefined;
    if (!u || !u.enabled) return false;
    const candidates = new Set<string>(['changeme']);
    if (config.ADMIN_PASSWORD) candidates.add(config.ADMIN_PASSWORD);
    for (const candidate of candidates) {
      if (candidate && verifyPassword(candidate, u.password_hash)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getUserLibraryIds(userId: number): number[] {
  const rows = getDb()
    .prepare(`SELECT library_id FROM library_access WHERE user_id = ?`)
    .all(userId) as { library_id: number }[];
  return rows.map((r) => r.library_id);
}
