import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Server } from 'http';

describe('security, scanner, shares, HLS helpers & HTTP API', () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-api-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    process.env.ADMIN_PASSWORD = 'admin-secret-password';
    fs.mkdirSync(process.env.DATA_PATH, { recursive: true });
    fs.mkdirSync(process.env.MEDIA_PATH, { recursive: true });

    const { getDb, closeDb } = await import('../src/db/schema');
    closeDb();
    getDb();

    // Create sample media files + Synology @eaDir that must be ignored
    const moviesDir = path.join(process.env.MEDIA_PATH, 'Movies', 'Inception (2010)');
    const eaDir = path.join(moviesDir, '@eaDir');
    const seriesDir = path.join(process.env.MEDIA_PATH, 'Series', 'Dark');
    fs.mkdirSync(eaDir, { recursive: true });
    fs.mkdirSync(seriesDir, { recursive: true });

    fs.writeFileSync(path.join(moviesDir, 'Inception.mp4'), '0123456789ABCDEF');
    fs.writeFileSync(path.join(eaDir, 'SYNOVIDEO_thumb.mp4'), 'THUMBNAIL');
    fs.writeFileSync(path.join(seriesDir, 'Dark.S01E01.mkv'), 'EPISODE_1_DATA');

    const { scanLibrary } = await import('../src/scanner/scan');
    scanLibrary();

    const { createApp } = await import('../src/index');
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      const { closeDb } = await import('../src/db/schema');
      closeDb();
    } catch {}
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('ignores Synology @eaDir during library scan', async () => {
    const { getDb } = await import('../src/db/schema');
    const items = getDb().prepare('SELECT filename FROM media_items').all() as { filename: string }[];
    const names = items.map((i) => i.filename);
    assert.ok(names.includes('Inception.mp4'));
    assert.ok(names.includes('Dark.S01E01.mkv'));
    assert.equal(names.includes('SYNOVIDEO_thumb.mp4'), false);
  });

  it('validates library paths against traversal and system/data dirs', async () => {
    const { validateLibraryPath } = await import('../src/libraries/libraries');
    assert.throws(() => validateLibraryPath('../outside'), /MEDIA_PATH/);
    assert.throws(() => validateLibraryPath('/etc/passwd'), /interdit/);
    assert.throws(() => validateLibraryPath(process.env.DATA_PATH!), /interdit/);
    const ok = validateLibraryPath('Movies');
    assert.ok(ok.startsWith(process.env.MEDIA_PATH!));
  });

  it('rejects arbitrary system files in isPathAllowed', async () => {
    const { isPathAllowed } = await import('../src/routes/stream');
    assert.equal(isPathAllowed('/etc/hosts'), false);
    assert.equal(isPathAllowed(path.join(process.env.DATA_PATH!, 'library.db')), false);
    const validFile = path.join(process.env.MEDIA_PATH!, 'Movies', 'Inception (2010)', 'Inception.mp4');
    assert.equal(isPathAllowed(validFile), true);
  });

  it('enforces rate limiting after repeated failed attempts', async () => {
    const {
      isRateLimited,
      recordFailedAttempt,
      clearFailedAttempts,
      _clearRateLimitsForTests,
    } = await import('../src/auth/rateLimit');
    _clearRateLimitsForTests();
    const key = 'login:1.2.3.4:admin';
    for (let i = 0; i < 3; i++) {
      assert.equal(isRateLimited(key, 3, 60_000).limited, false);
      recordFailedAttempt(key, 60_000);
    }
    const blocked = isRateLimited(key, 3, 60_000);
    assert.equal(blocked.limited, true);
    assert.ok(blocked.retryAfterSec > 0);
    clearFailedAttempts(key);
    assert.equal(isRateLimited(key, 3, 60_000).limited, false);
  });

  it('updates and revokes user sessions and stream tokens on user changes', async () => {
    const { createUser, updateUser, deleteUser } = await import('../src/users/users');
    const { createSession, getSessionUser } = await import('../src/auth/session');
    const { createStreamToken, resolveStreamToken } = await import('../src/auth/streamTokens');

    const u = createUser({ username: 'alice', password: 'password123', role: 'user', can_share: true });
    const sessTok = createSession({ id: u.id, username: u.username, role: u.role, can_share: u.can_share });
    const streamTok = createStreamToken({ mediaId: 1, userId: u.id, scope: 'raw' });

    // Updating can_share updates live session immediately
    updateUser(u.id, { can_share: false });
    assert.equal(getSessionUser(sessTok)?.can_share, false);

    // Disabling user destroys live session and stream tokens
    updateUser(u.id, { enabled: false });
    assert.equal(getSessionUser(sessTok), null);
    assert.equal(resolveStreamToken(streamTok), null);

    assert.equal(deleteUser(u.id), true);
  });

  it('deduplicates share max_uses within a client playback lease', async () => {
    const { getDb } = await import('../src/db/schema');
    const { createShare, resolveShare, consumeShareUse, _clearShareLeasesForTests } = await import(
      '../src/shares/shares'
    );
    _clearShareLeasesForTests();

    const item = getDb().prepare('SELECT id FROM media_items LIMIT 1').get() as { id: number };
    const share = createShare({ mediaId: item.id, maxUses: 1 });

    // Client 1 initial request + multiple Range requests
    const c1 = '10.0.0.1|Mozilla';
    assert.equal(resolveShare(share.token, undefined, c1).ok, true);
    consumeShareUse(share.token, c1);
    // Second Range request from same client 1 still succeeds!
    assert.equal(resolveShare(share.token, undefined, c1).ok, true);
    consumeShareUse(share.token, c1);

    // Client 2 is blocked because max_uses (1) was reached by Client 1
    const c2 = '10.0.0.2|VLC';
    const r2 = resolveShare(share.token, undefined, c2);
    assert.equal(r2.ok, false);
  });

  it('validates HLS playlist readiness and appends query tokens to segments', async () => {
    const { isPlaylistPlayable, formatPlaylistWithQuery } = await import('../src/transcode/hls');
    const headerOnly = path.join(tmp, 'header.m3u8');
    const playable = path.join(tmp, 'playable.m3u8');
    fs.writeFileSync(headerOnly, '#EXTM3U\n#EXT-X-VERSION:3\n');
    fs.writeFileSync(playable, '#EXTM3U\n#EXTINF:4.000,\nseg_00000.ts\n');

    assert.equal(isPlaylistPlayable(headerOnly), false);
    assert.equal(isPlaylistPlayable(playable), true);

    const rewritten = formatPlaylistWithQuery(
      '#EXTM3U\n#EXTINF:4.0,\nseg_00000.ts\nseg_00001.ts\n',
      'token=abc123'
    );
    assert.ok(rewritten.includes('seg_00000.ts?token=abc123'));
    assert.ok(rewritten.includes('seg_00001.ts?token=abc123'));
  });

  it('redirects unauthenticated GET / and supports HTTP Range streaming', async () => {
    // Unauthenticated root redirects to /login.html
    const rootRes = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(rootRes.status, 302);
    assert.equal(rootRes.headers.get('location'), '/login.html');

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret-password' }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    assert.ok(cookie.startsWith('nas_sm_session='));

    // Authenticated GET / serves index.html
    const authedRoot = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(authedRoot.status, 200);

    // Get movie item
    const mediaRes = await fetch(`${baseUrl}/api/media?q=Inception`, { headers: { Cookie: cookie } });
    const mediaData = (await mediaRes.json()) as { items: Array<{ id: number }> };
    assert.equal(mediaData.items.length, 1);
    const movieId = mediaData.items[0].id;

    // Range request bytes=0-3 -> "0123"
    const rangeRes = await fetch(`${baseUrl}/api/stream/${movieId}`, {
      headers: { Cookie: cookie, Range: 'bytes=0-3' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 0-3/16');
    assert.equal(await rangeRes.text(), '0123');

    // Suffix range request bytes=-4 -> "CDEF"
    const suffixRes = await fetch(`${baseUrl}/api/stream/${movieId}`, {
      headers: { Cookie: cookie, Range: 'bytes=-4' },
    });
    assert.equal(suffixRes.status, 206);
    assert.equal(suffixRes.headers.get('content-range'), 'bytes 12-15/16');
    assert.equal(await suffixRes.text(), 'CDEF');

    // Out-of-bounds range -> 416
    const badRange = await fetch(`${baseUrl}/api/stream/${movieId}`, {
      headers: { Cookie: cookie, Range: 'bytes=100-200' },
    });
    assert.equal(badRange.status, 416);
  });

  it('supports public URL, QR codes, folder browse, folder shares and isolation', async () => {
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret-password' }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

    const putUrl = await fetch(`${baseUrl}/api/admin/settings/public-url`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ publicBaseUrl: 'https://media.example.ts.net' }),
    });
    assert.equal(putUrl.status, 200);
    const putData = (await putUrl.json()) as { publicBaseUrl: string };
    assert.equal(putData.publicBaseUrl, 'https://media.example.ts.net');

    const qrRes = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent('https://media.example.ts.net/s/abc')}`);
    assert.equal(qrRes.status, 200);
    assert.match(qrRes.headers.get('content-type') || '', /image\/svg\+xml/);
    const svg = await qrRes.text();
    assert.ok(svg.includes('<svg'));

    const libsRes = await fetch(`${baseUrl}/api/libraries`, { headers: { Cookie: cookie } });
    const libsData = (await libsRes.json()) as {
      libraries: Array<{ id: number; type: string; name: string }>;
    };
    const seriesLib = libsData.libraries.find((l) => l.type === 'series');
    assert.ok(seriesLib);

    const foldersRes = await fetch(`${baseUrl}/api/folders?library_id=${seriesLib!.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(foldersRes.status, 200);
    const folders = (await foldersRes.json()) as {
      subfolders: Array<{ name: string; path: string }>;
      items: unknown[];
      total_in_tree: number;
    };
    assert.ok(folders.total_in_tree >= 1);

    const seriesDir = path.join(process.env.MEDIA_PATH!, 'Series', 'Dark');
    fs.writeFileSync(path.join(seriesDir, 'Dark.S01E02.mkv'), 'EPISODE_2_DATA');
    const otherDir = path.join(process.env.MEDIA_PATH!, 'Series', 'OtherShow');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'Other.S01E01.mkv'), 'OTHER_EP_DATA');
    const { scanLibrary } = await import('../src/scanner/scan');
    scanLibrary();

    const { getDb } = await import('../src/db/schema');
    const darkEps = getDb()
      .prepare(`SELECT id, rel_path FROM media_items WHERE rel_path LIKE 'Dark/%' ORDER BY filename`)
      .all() as Array<{ id: number; rel_path: string }>;
    assert.ok(darkEps.length >= 2);
    const otherEp = getDb()
      .prepare(`SELECT id FROM media_items WHERE rel_path LIKE 'OtherShow/%' LIMIT 1`)
      .get() as { id: number };
    assert.ok(otherEp);

    const shareRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        targetType: 'folder',
        libraryId: seriesLib!.id,
        folderPath: 'Dark',
      }),
    });
    assert.equal(shareRes.status, 201);
    const share = (await shareRes.json()) as { token: string; url: string; qrUrl: string };
    assert.ok(share.token);
    assert.ok(share.url.includes('https://media.example.ts.net/s/'));
    assert.ok(share.qrUrl.startsWith('/api/qr?text='));

    const publicRes = await fetch(`${baseUrl}/api/public/share/${share.token}`);
    assert.equal(publicRes.status, 200);
    const pub = (await publicRes.json()) as {
      targetType: string;
      itemCount: number;
      items: Array<{ id: number }>;
      shareUrl: string;
      qrUrl: string;
    };
    assert.equal(pub.targetType, 'folder');
    assert.ok(pub.itemCount >= 2);
    assert.ok(pub.items.some((i) => i.id === darkEps[0].id));
    assert.equal(pub.items.some((i) => i.id === otherEp.id), false);

    const streamOk = await fetch(
      `${baseUrl}/api/public/share/${share.token}/item/${darkEps[0].id}/stream`
    );
    assert.equal(streamOk.status, 200);
    assert.equal(await streamOk.text(), 'EPISODE_1_DATA');

    const streamBlocked = await fetch(
      `${baseUrl}/api/public/share/${share.token}/item/${otherEp.id}/stream`
    );
    assert.equal(streamBlocked.status, 404);

    const playlistRes = await fetch(`${baseUrl}/api/public/playlist/${share.token}`);
    assert.equal(playlistRes.status, 200);
    const m3u = await playlistRes.text();
    assert.ok(m3u.startsWith('#EXTM3U'));
    const infCount = (m3u.match(/#EXTINF/g) || []).length;
    assert.ok(infCount >= 2);
    assert.ok(m3u.includes(`/api/public/share/${share.token}/item/`));
  });
});
