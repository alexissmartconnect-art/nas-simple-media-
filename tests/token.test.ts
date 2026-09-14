import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('passwords + sessions', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-'));
    process.env.DATA_PATH = tmp;
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    process.env.ADMIN_PASSWORD = 'test-admin-pass';
    fs.mkdirSync(process.env.MEDIA_PATH, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('hashes and verifies passwords', async () => {
    const { hashPassword, verifyPassword } = await import('../src/auth/passwords');
    const stored = hashPassword('secret123');
    assert.ok(stored.startsWith('scrypt:'));
    assert.equal(verifyPassword('secret123', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
  });

  it('creates user sessions', async () => {
    const { createSession, getSessionUser, destroySession } = await import('../src/auth/session');
    const tok = createSession({
      id: 1,
      username: 'admin',
      role: 'admin',
      can_share: true,
    });
    const u = getSessionUser(tok);
    assert.ok(u);
    assert.equal(u!.username, 'admin');
    destroySession(tok);
    assert.equal(getSessionUser(tok), null);
  });

  it('authenticate admin from seeded DB', async () => {
    // reset module caches for db path
    const { getDb, closeDb } = await import('../src/db/schema');
    closeDb();
    getDb();
    const { authenticate } = await import('../src/users/users');
    const user = authenticate('admin', 'test-admin-pass');
    assert.ok(user);
    assert.equal(user!.role, 'admin');
    assert.equal(authenticate('admin', 'wrong'), null);
  });
});
