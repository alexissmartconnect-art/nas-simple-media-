import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Server } from 'http';

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(REPO_ROOT, 'public');

describe('PWA: manifest, service worker, icons, vendored hls.js', () => {
  let tmp: string;
  let server: Server;
  let baseUrl = '';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-pwa-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-secret-password';
    fs.mkdirSync(process.env.DATA_PATH, { recursive: true });
    fs.mkdirSync(process.env.MEDIA_PATH, { recursive: true });
    const { getDb } = await import('../src/db/schema');
    getDb();
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
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('serves a valid web app manifest with the right content-type', async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^application\/manifest\+json/);
    const m = await res.json();
    assert.equal(m.start_url, '/');
    assert.equal(m.display, 'standalone');
    assert.ok(m.name && m.short_name);
    const sizes = (m.icons as { sizes: string; purpose?: string }[]).map((i) => `${i.sizes}:${i.purpose || 'any'}`);
    for (const want of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(sizes.includes(want), want);
  });

  it('serves every manifest icon as a PNG of the declared size', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
    for (const icon of m.icons as { src: string; sizes: string; type: string }[]) {
      const res = await fetch(baseUrl + icon.src);
      assert.equal(res.status, 200, icon.src);
      if (icon.type !== 'image/png') continue;
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', icon.src);
      const [w, h] = icon.sizes.split('x').map(Number);
      assert.equal(buf.readUInt32BE(16), w, icon.src);
      assert.equal(buf.readUInt32BE(20), h, icon.src);
    }
  });

  it('serves /sw.js at root scope, uncached, with a versioned cache name', async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.ok(body.includes(`const VERSION = '${pkg.version}'`));
    assert.equal(body.includes('__APP_VERSION__'), false);
  });

  it('service worker never caches API, shares or media', () => {
    const src = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    assert.match(src, /startsWith\('\/api\/'\)/);
    assert.match(src, /startsWith\('\/s\/'\)/);
    assert.match(src, /headers\.has\('range'\)/);
    assert.match(src, /if \(url\.search\) return false/);
    // every precached URL must be a static shell file
    const shell = src.match(/const SHELL = \[([\s\S]*?)\];/)![1];
    assert.equal(/\/api\/|\/s\/|hls\?|\.m3u8|\.ts'/.test(shell), false);
  });

  it('precached shell files all exist', async () => {
    for (const p of ['/css/style.css', '/js/app.js', '/js/pwa.js', '/vendor/hls.js/hls.min.js', '/offline.html']) {
      const res = await fetch(baseUrl + p);
      assert.equal(res.status, 200, p);
    }
  });

  it('pages link the manifest and load hls.js locally (no CDN)', () => {
    for (const page of ['index.html', 'login.html', 'share.html']) {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'), page);
      assert.ok(html.includes('name="theme-color"'), page);
      assert.ok(html.includes('rel="apple-touch-icon"'), page);
      assert.ok(html.includes('src="/js/pwa.js"'), page);
      assert.equal(html.includes('cdn.jsdelivr.net'), false, page);
    }
    const vendored = fs.readFileSync(path.join(PUBLIC, 'vendor', 'hls.js', 'hls.min.js'), 'utf8');
    assert.ok(vendored.length > 100_000);
  });

  it('still redirects / to the login page when signed out', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html');
    const login = await fetch(`${baseUrl}/login.html`);
    assert.equal(login.status, 200);
  });
});
