import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('playback progress + continue watching + probe cache', () => {
  let tmp: string;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-playback-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    process.env.ADMIN_PASSWORD = 'admin-secret-password';
    const { getDb, closeDb } = await import('../src/db/schema');
    closeDb();
    const db = getDb();
    const userId = Number(
      (
        db
          .prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')`)
          .run('bob', 'x') as { lastInsertRowid: number | bigint }
      ).lastInsertRowid
    );
    const libId = Number(
      (
        db
          .prepare(`INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)`)
          .run('Films Test', 'movies', 'MoviesTest') as { lastInsertRowid: number | bigint }
      ).lastInsertRowid
    );
    (globalThis as Record<string, unknown>).__ids = { userId, libId };
    const ins = db.prepare(
      `INSERT INTO media_items (library_id, path, rel_path, filename, title, type, kind, size_bytes, mtime)
       VALUES (?, ?, ?, ?, ?, 'movie', 'movies', 100, 1)`
    );
    ins.run(libId, '/media/a.mkv', 'a.mkv', 'a.mkv', 'Film A');
    ins.run(libId, '/media/b.mkv', 'b.mkv', 'b.mkv', 'Film B');
  });

  after(async () => {
    try {
      const { closeDb } = await import('../src/db/schema');
      closeDb();
    } catch {}
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function ids() {
    return (globalThis as Record<string, unknown>).__ids as { userId: number; libId: number };
  }

  async function mediaIdByTitle(title: string): Promise<number> {
    const { getDb } = await import('../src/db/schema');
    const row = getDb().prepare('SELECT id FROM media_items WHERE title = ?').get(title) as {
      id: number;
    };
    return row.id;
  }

  it('saves, reads and clears progress; marks watched near the end', async () => {
    const { saveProgress, getProgress, clearProgress } = await import('../src/playback/progress');
    const { userId } = ids();
    const mid = await mediaIdByTitle('Film A');

    assert.equal(getProgress(userId, mid), null);
    const p1 = saveProgress(userId, mid, 60000, 3600000);
    assert.ok(p1);
    assert.equal(p1!.position_ms, 60000);
    assert.equal(p1!.watched, false);

    // >95% → watched
    const p2 = saveProgress(userId, mid, 3590000, 3600000);
    assert.equal(p2!.watched, true);

    clearProgress(userId, mid);
    assert.equal(getProgress(userId, mid), null);
  });

  it('lists continue-watching ordered by recency, excluding watched', async () => {
    const { saveProgress, listContinueWatching } = await import('../src/playback/progress');
    const { userId, libId } = ids();
    const a = await mediaIdByTitle('Film A');
    const b = await mediaIdByTitle('Film B');
    saveProgress(userId, a, 60000, 3600000);
    saveProgress(userId, b, 120000, 3600000);
    saveProgress(userId, a, 3590000, 3600000); // A becomes watched

    const list = listContinueWatching(userId, [libId], 10);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, b);
    assert.ok(list[0].progress_ratio > 0 && list[0].progress_ratio < 1);
  });

  it('lists recently added', async () => {
    const { listRecentlyAdded } = await import('../src/playback/progress');
    const { libId } = ids();
    const list = listRecentlyAdded([libId], 10);
    assert.equal(list.length, 2);
  });

  it('caches and invalidates ffprobe results', async () => {
    const { getDb } = await import('../src/db/schema');
    const mod = await import('../src/media/probe');
    const item = getDb().prepare('SELECT * FROM media_items LIMIT 1').get() as Parameters<
      typeof mod.getCachedProbe
    >[0];
    assert.equal(mod.getCachedProbe(item), null);
    const fake = {
      container: '.mkv',
      durationMs: 1000,
      sizeBytes: 1,
      bitrate: 1,
      video: [],
      audio: [],
      subtitles: [],
      probedAt: new Date().toISOString(),
    };
    mod.saveProbe(item, fake);
    assert.deepEqual(mod.getCachedProbe(item), fake);
    mod.invalidateProbe(item.id);
    assert.equal(mod.getCachedProbe(item), null);
  });
});
