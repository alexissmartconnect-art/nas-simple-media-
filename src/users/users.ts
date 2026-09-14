import { getDb, type UserRow, type SessionUser } from '../db/schema';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { destroyUserSessions } from '../auth/session';

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

  if (patch.password || patch.enabled === false) destroyUserSessions(id);
  return publicUser(getUser(id)!);
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

export function getUserLibraryIds(userId: number): number[] {
  const rows = getDb()
    .prepare(`SELECT library_id FROM library_access WHERE user_id = ?`)
    .all(userId) as { library_id: number }[];
  return rows.map((r) => r.library_id);
}
