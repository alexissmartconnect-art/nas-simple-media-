import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Server } from 'http';

/**
 * Phase 0 — security hardening. Runs with the factory password (`changeme`)
 * so the forced password change can be exercised end to end.
 */
describe('security hardening (phase 0)', () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;
  let adminCookie = '';
  const NEW_ADMIN_PASSWORD = 'Un-vrai-mot-de-passe-42';

  async function login(username: string, password: string, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ username, password }),
    });
  }
  function cookieOf(res: Response): string {
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-sec-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    delete process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY_HOPS;
    fs.mkdirSync(process.env.DATA_PATH, { recursive: true });
    const moviesDir = path.join(process.env.MEDIA_PATH, 'Movies', 'Secret Movie (2020)');
    fs.mkdirSync(moviesDir, { recursive: true });
    fs.writeFileSync(path.join(moviesDir, 'Secret.Movie.mp4'), 'MOVIE_BYTES_0123456789');

    const { getDb } = await import('../src/db/schema');
    getDb();
    const { scanLibrary } = await import('../src/scanner/scan');
    scanLibrary();
    const { createApp } = await import('../src/index');
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const { closeDb } = await import('../src/db/schema');
      closeDb();
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses TRUST_PROXY_HOPS safely (never "trust everyone")', async () => {
    const { parseTrustProxy, DEFAULT_TRUST_PROXY } = await import('../src/config');
    assert.equal(parseTrustProxy(undefined, undefined), DEFAULT_TRUST_PROXY);
    assert.equal(parseTrustProxy(undefined, '1'), DEFAULT_TRUST_PROXY, 'legacy TRUST_PROXY=1 → safe default');
    assert.equal(parseTrustProxy(undefined, '0'), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy('true'), DEFAULT_TRUST_PROXY);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
  });

  it('only trusts X-Forwarded-For from loopback / private proxies', async () => {
    const { createApp } = await import('../src/index');
    const trust = createApp().get('trust proxy fn') as (addr: string, i: number) => boolean;
    assert.equal(trust('127.0.0.1', 0), true);
    assert.equal(trust('::1', 0), true);
    assert.equal(trust('172.17.0.1', 0), true, 'Docker bridge / DSM reverse proxy');
    assert.equal(trust('192.168.1.10', 0), true);
    assert.equal(trust('203.0.113.7', 0), false, 'an Internet client cannot spoof its IP');
    assert.equal(trust('82.64.1.2', 0), false);
  });

  it('generates a random SESSION_SECRET once and keeps it in DATA_PATH', async () => {
    const { config, loadOrCreateSessionSecret } = await import('../src/config');
    const file = path.join(process.env.DATA_PATH!, 'session.secret');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(file, 'utf8').trim(), config.SESSION_SECRET);
    assert.ok(config.SESSION_SECRET.length >= 64);
    assert.equal(config.SESSION_SECRET.includes('changeme'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(loadOrCreateSessionSecret(process.env.DATA_PATH!), config.SESSION_SECRET, 'stable across restarts');
    assert.equal(loadOrCreateSessionSecret(process.env.DATA_PATH!, 'x'.repeat(40)), 'x'.repeat(40));
  });

  it('sends CSP / anti-framing headers, and HSTS only over HTTPS', async () => {
    const res = await fetch(`${baseUrl}/login.html`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("script-src 'self'"));
    assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false, 'no inline scripts allowed');
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(/worker-src[^;]*blob:/.test(csp), 'hls.js workers');
    assert.ok(/media-src[^;]*blob:/.test(csp), 'MediaSource');
    assert.equal(csp.includes('upgrade-insecure-requests'), false, 'plain HTTP on the LAN keeps working');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('strict-transport-security'), null);

    const https = await fetch(`${baseUrl}/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.ok((https.headers.get('strict-transport-security') || '').includes('max-age='));
  });

  it('serves pages without any inline <script> (CSP-compatible)', () => {
    const pub = path.join(__dirname, '..', 'public');
    for (const page of ['index.html', 'login.html', 'share.html', 'offline.html']) {
      const html = fs.readFileSync(path.join(pub, page), 'utf8');
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, `${page} has an inline script`);
      assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${page} has an inline event handler`);
    }
  });

  it('hides the default-password hint from non-LAN clients', async () => {
    const lan = (await (await fetch(`${baseUrl}/api/setup/status`)).json()) as {
      defaultAdminActive: boolean;
      passwordMinLength: number;
    };
    assert.equal(lan.defaultAdminActive, true);
    assert.equal(lan.passwordMinLength, 10);
    // Through a trusted local proxy, for an Internet client:
    const wan = (await (
      await fetch(`${baseUrl}/api/setup/status`, { headers: { 'X-Forwarded-For': '203.0.113.50' } })
    ).json()) as { defaultAdminActive: boolean; defaultAdminUser: string | null };
    assert.equal(wan.defaultAdminActive, false);
    assert.equal(wan.defaultAdminUser, null);
  });

  it('forces the change of the factory "changeme" password (server-enforced)', async () => {
    const res = await login('admin', 'changeme');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mustChangePassword: boolean; code: string };
    assert.equal(body.mustChangePassword, true);
    assert.equal(body.code, 'PASSWORD_CHANGE_REQUIRED');
    const cookie = cookieOf(res);

    const blocked = await fetch(`${baseUrl}/api/libraries`, { headers: { Cookie: cookie } });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { code: string }).code, 'PASSWORD_CHANGE_REQUIRED');
    const blockedAdmin = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookie } });
    assert.equal(blockedAdmin.status, 403);

    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json()) as {
      authenticated: boolean;
      mustChangePassword: boolean;
    };
    assert.equal(me.authenticated, true);
    assert.equal(me.mustChangePassword, true);

    const change = (newPassword: string, currentPassword = 'changeme') =>
      fetch(`${baseUrl}/api/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    const tooShort = await change('short1');
    assert.equal(tooShort.status, 400);
    assert.match(((await tooShort.json()) as { error: string }).error, /10/);
    assert.equal((await change('changeme-but-longer')).status, 400, 'too close to the default');

    // A second device logged in before the change gets logged out.
    const other = cookieOf(await login('admin', 'changeme'));
    assert.equal((await change(NEW_ADMIN_PASSWORD)).status, 200);

    const ok = await fetch(`${baseUrl}/api/libraries`, { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200, 'current session continues after the change');
    const otherMe = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: other } })).json()) as {
      authenticated: boolean;
    };
    assert.equal(otherMe.authenticated, false);
    assert.equal((await login('admin', 'changeme')).status, 401);
    adminCookie = cookie;

    const after = (await (await fetch(`${baseUrl}/api/setup/status`)).json()) as { defaultAdminActive: boolean };
    assert.equal(after.defaultAdminActive, false);
  });

  it('requires 10+ characters for new passwords without locking out existing users', async () => {
    const { createUser, updateUser } = await import('../src/users/users');
    assert.throws(() => createUser({ username: 'bob', password: 'abcd1234' }), /min 10/);
    const bob = createUser({ username: 'bob', password: 'abcdefghij' });
    assert.throws(() => updateUser(bob.id, { password: 'short' }), /min 10/);

    // Legacy account created before the rule with a 4-char password still logs in.
    const { getDb } = await import('../src/db/schema');
    const { hashPassword } = await import('../src/auth/passwords');
    getDb()
      .prepare(`INSERT INTO users (username, password_hash, role) VALUES ('legacy', ?, 'user')`)
      .run(hashPassword('abcd'));
    const res = await login('legacy', 'abcd');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { mustChangePassword: boolean }).mustChangePassword, false);
  });

  it('persists sessions in SQLite: survives a restart, logout and expiry invalidate them', async () => {
    const res = await login('admin', NEW_ADMIN_PASSWORD);
    const cookie = cookieOf(res);
    const raw = decodeURIComponent(cookie.split('=')[1]);

    const { getDb, closeDb } = await import('../src/db/schema');
    const row = getDb().prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(raw) as unknown;
    assert.equal(row, undefined, 'the raw token is never stored');
    closeDb(); // simulate a NAS / container restart
    getDb();
    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json()) as {
      authenticated: boolean;
    };
    assert.equal(me.authenticated, true);

    await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const gone = await fetch(`${baseUrl}/api/libraries`, { headers: { Cookie: cookie } });
    assert.equal(gone.status, 401, 'a copied cookie is useless after logout');

    const c2 = cookieOf(await login('admin', NEW_ADMIN_PASSWORD));
    const { _expireSessionsForTests } = await import('../src/auth/session');
    _expireSessionsForTests();
    assert.equal((await fetch(`${baseUrl}/api/libraries`, { headers: { Cookie: c2 } })).status, 401);
    adminCookie = cookieOf(await login('admin', NEW_ADMIN_PASSWORD));
  });

  it('marks the session cookie Secure only over HTTPS, HttpOnly + SameSite=Lax always', async () => {
    const plain = (await login('admin', NEW_ADMIN_PASSWORD)).headers.get('set-cookie') || '';
    assert.match(plain, /HttpOnly/i);
    assert.match(plain, /SameSite=Lax/i);
    assert.equal(/;\s*Secure/i.test(plain), false);
    const https = (await login('admin', NEW_ADMIN_PASSWORD, { 'X-Forwarded-Proto': 'https' })).headers.get(
      'set-cookie'
    );
    assert.match(https || '', /;\s*Secure/i);
  });

  it('locks an account after repeated failures from the Internet, not from the LAN', async () => {
    const { _clearRateLimitsForTests } = await import('../src/auth/rateLimit');
    _clearRateLimitsForTests();
    for (let i = 0; i < 10; i++) {
      const r = await login('bob', 'wrong-password', { 'X-Forwarded-For': `198.51.100.${i + 1}` });
      assert.equal(r.status, 401);
    }
    const locked = await login('bob', 'abcdefghij', { 'X-Forwarded-For': '198.51.100.200' });
    assert.equal(locked.status, 429);
    assert.equal(((await locked.json()) as { code: string }).code, 'ACCOUNT_LOCKED');
    assert.equal((await login('bob', 'abcdefghij')).status, 200, 'LAN owner is never locked out');
    _clearRateLimitsForTests();
  });

  it('applies a global per-IP rate limit on /api/login', async () => {
    const { _clearRateLimitsForTests } = await import('../src/auth/rateLimit');
    _clearRateLimitsForTests();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await login(`nobody${i}`, 'x', { 'X-Forwarded-For': '192.0.2.77' })).status;
    }
    assert.equal(last, 429);
    _clearRateLimitsForTests();
  });

  it('exchanges the share password for a signed token: no password in URLs, no NAS paths', async () => {
    const media = (await (
      await fetch(`${baseUrl}/api/media?q=Secret`, { headers: { Cookie: adminCookie } })
    ).json()) as { items: Array<{ id: number }> };
    const mediaId = media.items[0].id;
    const created = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ targetType: 'media', mediaId, password: 'share-pass' }),
    });
    assert.equal(created.status, 201);
    const share = (await created.json()) as { token: string; has_password: boolean; password_hash?: string };
    assert.equal(share.has_password, true);
    assert.equal(share.password_hash, undefined, 'hash never leaves the server');
    const t = share.token;

    const locked = (await (await fetch(`${baseUrl}/api/public/share/${t}`)).json()) as { needsPassword: boolean };
    assert.equal(locked.needsPassword, true);

    const unlock = (password: string) =>
      fetch(`${baseUrl}/api/public/share/${t}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    assert.equal((await unlock('nope')).status, 403);
    const ok = await unlock('share-pass');
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie') || '';
    assert.match(setCookie, /nas_sm_sa_[0-9a-f]{16}=/);
    assert.match(setCookie, /Path=\/api\/public\//);
    assert.match(setCookie, /HttpOnly/i);
    const { accessToken } = (await ok.json()) as { accessToken: string };
    assert.match(accessToken, /^v1\./);

    // Browser path: the cookie alone unlocks the share.
    const shareCookie = setCookie.split(';')[0];
    const info = await fetch(`${baseUrl}/api/public/share/${t}`, { headers: { Cookie: shareCookie } });
    const data = (await info.json()) as { needsPassword: boolean; items: Array<Record<string, unknown>> };
    assert.equal(data.needsPassword, false);
    assert.ok(data.items.length >= 1);
    for (const it of data.items) {
      assert.equal('path' in it, false);
      assert.equal('rel_path' in it, false);
    }
    assert.equal(JSON.stringify(data).includes(process.env.MEDIA_PATH!), false, 'no NAS path in the response');

    // Native / VLC path: the token in the query; generated URLs carry access=, never password=.
    const vlc = (await (
      await fetch(`${baseUrl}/api/public/share/${t}/item/${mediaId}/vlc?access=${encodeURIComponent(accessToken)}`)
    ).json()) as { streamUrl: string; m3uUrl: string };
    assert.ok(vlc.streamUrl.includes('access='));
    assert.equal(vlc.streamUrl.includes('password'), false);
    assert.equal(vlc.m3uUrl.includes('password'), false);
    const stream = await fetch(vlc.streamUrl.replace(/^https?:\/\/[^/]+/, baseUrl));
    assert.equal(stream.status, 200);
    assert.equal(await stream.text(), 'MOVIE_BYTES_0123456789');

    const m3u = await (
      await fetch(`${baseUrl}/api/public/playlist/${t}`, { headers: { 'X-Share-Access': accessToken } })
    ).text();
    assert.ok(m3u.startsWith('#EXTM3U'));
    assert.equal(m3u.includes('password'), false);
    assert.ok(m3u.includes('access='));

    // A forged / truncated token does not unlock anything.
    const forged = (await (
      await fetch(`${baseUrl}/api/public/share/${t}?access=${encodeURIComponent(accessToken.slice(0, -2) + 'xx')}`)
    ).json()) as { needsPassword: boolean };
    assert.equal(forged.needsPassword, true);
    const { verifyShareAccessToken } = await import('../src/shares/shareAccess');
    assert.equal(verifyShareAccessToken('another-share', 'hash', accessToken), false);

    // Transition: old links with ?password= still open, but what we hand out is token-based.
    const legacy = await fetch(`${baseUrl}/api/public/share/${t}/item/${mediaId}/vlc?password=share-pass`);
    assert.equal(legacy.status, 200);
    const legacyVlc = (await legacy.json()) as { streamUrl: string };
    assert.equal(legacyVlc.streamUrl.includes('password'), false);
    assert.ok(legacyVlc.streamUrl.includes('access=v1.'));
  });

  it('applies a global per-IP rate limit on /api/public/*', async () => {
    const { _clearRateLimitsForTests, hitRateLimit } = await import('../src/auth/rateLimit');
    _clearRateLimitsForTests();
    for (let i = 0; i < 600; i++) hitRateLimit('public:192.0.2.99', 600, 60_000);
    const res = await fetch(`${baseUrl}/api/public/share/whatever`, { headers: { 'X-Forwarded-For': '192.0.2.99' } });
    assert.equal(res.status, 429);
    const other = await fetch(`${baseUrl}/api/public/share/whatever`, { headers: { 'X-Forwarded-For': '192.0.2.100' } });
    assert.notEqual(other.status, 429);
    _clearRateLimitsForTests();
  });

  it('ships a non-root Docker image whose tag follows package.json', () => {
    const root = path.join(__dirname, '..');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /chown -R node:node \/data/);
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    assert.ok(compose.includes(`image: nas-simple-media:${pkg.version}`), 'compose image tag = package version');
    assert.ok(compose.includes('127.0.0.1:8096:8096'), 'loopback-only proxy mode documented');
    assert.match(compose, /^\s+- "8096:8096"$/m, 'default stays reachable on the LAN');
  });
});
