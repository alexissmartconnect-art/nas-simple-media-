import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Request } from 'express';

/** Minimal Express request stub for the URL / proxy helpers. */
function fakeReq(headers: Record<string, string> = {}, protocol = 'http'): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    protocol,
    get(name: string) {
      return lower[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('NAS / USB file explorer + Synology path resolution + external access', () => {
  let tmp: string;
  let media: string;
  let data: string;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-fs-'));
    media = path.join(tmp, 'media');
    data = path.join(tmp, 'data');
    fs.mkdirSync(data, { recursive: true });
    process.env.DATA_PATH = data;
    process.env.MEDIA_PATH = media;
    process.env.PUBLIC_BASE_URL = `http://localhost:8096`;

    // Sample NAS layout: media at the root, nested folders, Synology metadata.
    for (const dir of [
      path.join(media, 'Movies', 'Inception (2010)'),
      path.join(media, 'Series', 'Dark'),
      path.join(media, 'Music', 'Album'),
      path.join(media, '@eaDir'),
      path.join(media, '#recycle'),
      path.join(media, '.hidden'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(media, 'root-movie.mp4'), 'ROOT');
    fs.writeFileSync(path.join(media, 'Movies', 'Inception (2010)', 'Inception.mp4'), 'MOVIE');
    fs.writeFileSync(path.join(media, 'Series', 'Dark.S01E01.mkv'), 'EP');
    fs.writeFileSync(path.join(media, 'Music', 'Album', 'track.mp3'), 'AUDIO');
    fs.writeFileSync(path.join(media, '@eaDir', 'thumb.mp4'), 'THUMB');
    fs.writeFileSync(path.join(media, '#recycle', 'trash.mp4'), 'TRASH');
    fs.writeFileSync(path.join(media, '.hidden', 'hidden.mp4'), 'HIDDEN');

    const { getDb } = await import('../src/db/schema');
    getDb();
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // ---------------------------------------------------------------- explorer
  it('ignores Synology metadata folders and hidden files', async () => {
    const { isIgnoredDirName, IGNORED_DIR_NAMES } = await import('../src/fs/explorer');
    for (const name of ['@eaDir', '#recycle', '@tmp', '@appstore', '.hidden', '$RECYCLE.BIN']) {
      assert.equal(isIgnoredDirName(name), true, `${name} must be ignored`);
    }
    for (const name of ['Films', 'Movies', 'Music 2024']) {
      assert.equal(isIgnoredDirName(name), false, `${name} must be listed`);
    }
    assert.ok(IGNORED_DIR_NAMES.has('@eaDir'));
  });

  it('detects MEDIA_PATH as the first quick-access root', async () => {
    const { detectRoots } = await import('../src/fs/explorer');
    const roots = detectRoots();
    assert.ok(roots.length >= 1);
    assert.equal(roots[0].path, media);
    assert.equal(roots[0].kind, 'media');
    assert.equal(roots[0].readable, true);
    // /volume1 & friends do not exist in the test sandbox and must be skipped.
    assert.equal(roots.some((r) => r.path === '/volume1'), false);
  });

  it('lists subfolders with their media counters and skips metadata', async () => {
    const { listServerDirectory } = await import('../src/fs/explorer');
    const listing = listServerDirectory(media);
    assert.equal(listing.readable, true);
    assert.equal(listing.error, null);
    assert.deepEqual(
      listing.dirs.map((d) => d.name),
      ['Movies', 'Music', 'Series']
    );
    assert.equal(listing.mediaCount, 1, 'one media file directly in the browsed folder');
    assert.equal(listing.dirs.find((d) => d.name === 'Series')?.mediaCount, 1, 'media directly inside Series');
    assert.equal(listing.dirs.find((d) => d.name === 'Movies')?.mediaCount, 0, 'media nested one level deeper');
    assert.equal(listing.dirs.find((d) => d.name === 'Music')?.mediaCount, 0);
    assert.equal(listing.parent, tmp);
  });

  it('counts media files and resolves the parent folder when drilling down', async () => {
    const { listServerDirectory } = await import('../src/fs/explorer');
    const listing = listServerDirectory(path.join(media, 'Movies', 'Inception (2010)'));
    assert.equal(listing.path, path.join(media, 'Movies', 'Inception (2010)'));
    assert.equal(listing.parent, path.join(media, 'Movies'));
    assert.equal(listing.mediaCount, 1);
    assert.equal(listing.dirs.length, 0);
  });

  it('falls back to MEDIA_PATH when no path is given and requires absolute paths', async () => {
    const { listServerDirectory } = await import('../src/fs/explorer');
    const listing = listServerDirectory('');
    assert.equal(listing.path, media);
    assert.equal(listing.fallbackUsed, true);
    assert.throws(() => listServerDirectory('Movies'), /Chemin absolu requis/);
  });

  it('explains missing folders (ENOENT) and refuses system folders', async () => {
    const { listServerDirectory, DSM_PERMISSION_HELP } = await import('../src/fs/explorer');

    const missing = listServerDirectory('/volumeUSB1/usbshare1-2/Films');
    assert.equal(missing.readable, false);
    assert.match(missing.error || '', /introuvable/);
    assert.match(missing.hint || '', /volumeUSB/);

    const system = listServerDirectory('/etc');
    assert.equal(system.readable, false);
    assert.match(system.error || '', /interdit/);
    assert.ok(system.dirs.length === 0);

    const internal = listServerDirectory(path.join(data, 'cache'));
    assert.equal(internal.readable, false);
    assert.match(internal.error || '', /interdit/);

    assert.match(DSM_PERMISSION_HELP, /sc-nas-simple-media/);
    assert.match(DSM_PERMISSION_HELP, /Dossier partagé/);
  });

  it('returns a French ACL hint when the folder is not readable (EACCES)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const { listServerDirectory } = await import('../src/fs/explorer');
    const locked = path.join(media, 'Locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'secret.mp4'), 'SECRET');
    fs.chmodSync(locked, 0o000);
    try {
      const listing = listServerDirectory(locked);
      assert.equal(listing.readable, false);
      assert.match(listing.hint || '', /sc-nas-simple-media/);
      assert.match(listing.hint || '', /Lecture/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  // ------------------------------------------------------- Synology aliases
  it('translates File Station USB paths to their real mount points', async () => {
    const { synologyPathCandidates } = await import('../src/libraries/libraries');
    const dashed = synologyPathCandidates('/usbshare1-2/Film');
    assert.equal(dashed[0], '/volumeUSB1/usbshare1-2/Film');
    assert.ok(dashed.includes('/volumeUSB1/usbshare2/Film'));
    assert.equal(synologyPathCandidates('/usbshare1/Film')[0], '/volumeUSB1/usbshare/Film');
    assert.equal(synologyPathCandidates('/usbshare3/Film')[0], '/volumeUSB3/usbshare/Film');
    assert.ok(synologyPathCandidates('/usbshare1/Film').includes('/volumeUSB1/usbshare1/Film'));
    assert.deepEqual(synologyPathCandidates('/video/Films'), ['/volume1/video/Films']);
    assert.deepEqual(synologyPathCandidates('/music/Albums'), ['/volume1/music/Albums']);
    assert.deepEqual(synologyPathCandidates('/volume1/video'), []);
    assert.deepEqual(synologyPathCandidates('Movies'), []);
  });

  it('resolves `/usbshare*` and shared-folder aliases, keeping real paths intact', async () => {
    const { resolveLibraryPath, resolveSynologyAlias } = await import('../src/libraries/libraries');
    assert.equal(resolveLibraryPath('/usbshare1-2/Film'), '/volumeUSB1/usbshare1-2/Film');
    assert.equal(resolveLibraryPath('/usbshare1/Film'), '/volumeUSB1/usbshare/Film');
    assert.equal(resolveLibraryPath('/video/Films'), '/volume1/video/Films');
    assert.equal(resolveLibraryPath('/volumeUSB1/usbshare1-2/Film'), '/volumeUSB1/usbshare1-2/Film');
    // Existing absolute paths (Docker mounts, MEDIA_PATH) are never rewritten.
    assert.equal(resolveLibraryPath(path.join(media, 'Movies')), path.join(media, 'Movies'));
    // Relative paths still live under MEDIA_PATH.
    assert.equal(resolveLibraryPath('Movies'), path.join(media, 'Movies'));
    assert.equal(resolveSynologyAlias('/volume1/video'), null);
  });

  it('still refuses system paths after alias resolution', async () => {
    const { validateLibraryPath } = await import('../src/libraries/libraries');
    assert.throws(() => validateLibraryPath('/etc/shadow'), /interdit/);
    assert.throws(() => validateLibraryPath(path.join(data, 'library.db')), /interdit/);
    assert.equal(validateLibraryPath('/usbshare1/Films'), '/volumeUSB1/usbshare/Films');
    assert.equal(validateLibraryPath('/usbshare1-2/Films'), '/volumeUSB1/usbshare1-2/Films');
  });

  // ------------------------------------------------------- external access
  it('classifies private vs public hosts', async () => {
    const { isPrivateHost, isPrivateUrl, isLoopbackUrl } = await import('../src/shares/qr');
    for (const host of [
      'localhost',
      '127.0.0.1',
      '192.168.1.42',
      '10.0.0.7',
      '172.16.4.9',
      '172.31.255.1',
      'nas.local',
      '100.101.102.103',
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} must be private`);
    }
    for (const host of ['mon-nas.synology.me', 'media.example.com', '82.64.10.20', '172.32.0.1']) {
      assert.equal(isPrivateHost(host), false, `${host} must be public`);
    }
    assert.equal(isPrivateUrl('http://192.168.1.42:8096/s/abc'), true);
    assert.equal(isPrivateUrl('https://mon-nas.synology.me/s/abc'), false);
    assert.equal(isLoopbackUrl('http://192.168.1.42:8096'), false);
    // IPv4-mapped IPv6 peer addresses (Node) are classified like their IPv4 form.
    assert.equal(isPrivateHost('::ffff:192.168.1.42'), true);
    assert.equal(isPrivateHost('::ffff:82.64.10.20'), false);
  });

  it('honors X-Forwarded-Proto / X-Forwarded-Host from a Synology reverse proxy', async () => {
    const { originFromRequest, forwardedInfo } = await import('../src/shares/qr');

    const proxied = fakeReq({
      host: 'localhost:8096',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'mon-nas.synology.me',
      'x-forwarded-for': '82.64.10.20',
    });
    assert.equal(originFromRequest(proxied), 'https://mon-nas.synology.me');
    assert.deepEqual(forwardedInfo(proxied), {
      proto: 'https',
      host: 'mon-nas.synology.me',
      forwardedFor: '82.64.10.20',
      behindProxy: true,
    });

    // Multiple hops: the first (client-facing) value wins.
    const multi = fakeReq({
      host: 'localhost:8096',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'mon-nas.synology.me, localhost:8096',
    });
    assert.equal(originFromRequest(multi), 'https://mon-nas.synology.me');

    // Default HTTPS port is dropped from the URL.
    const withPort = fakeReq({
      host: 'localhost',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'mon-nas.synology.me:443',
    });
    assert.equal(originFromRequest(withPort), 'https://mon-nas.synology.me');

    // RFC 7239 Forwarded header (Cloudflare / nginx).
    const rfc = fakeReq({ host: 'localhost:8096', forwarded: 'for=82.64.10.20;proto=https;host=nas.example.fr' });
    assert.equal(originFromRequest(rfc), 'https://nas.example.fr');

    // No proxy headers at all: host header is used.
    assert.equal(originFromRequest(fakeReq({ host: '192.168.1.42:8096' })), 'http://192.168.1.42:8096');
    assert.equal(originFromRequest(undefined), null);
  });

  it('builds share links on the external URL seen through the proxy', async () => {
    const { resolvePublicBaseUrl } = await import('../src/shares/qr');
    const proxied = fakeReq({
      host: 'localhost:8096',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'mon-nas.synology.me',
    });
    assert.equal(resolvePublicBaseUrl(proxied), 'https://mon-nas.synology.me');

    const lan = fakeReq({ host: '192.168.1.42:8096' });
    assert.equal(resolvePublicBaseUrl(lan), 'http://192.168.1.42:8096');

    const loopback = fakeReq({ host: 'localhost:8096' });
    assert.equal(resolvePublicBaseUrl(loopback), 'http://localhost:8096');
  });

  it('describes the network for the admin panel (guide + proxy detection)', async () => {
    const { describeNetwork, EXTERNAL_ACCESS_GUIDE, isIPv4 } = await import('../src/net/network');
    const proxied = fakeReq({
      host: 'localhost:8096',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'mon-nas.synology.me',
    });
    const net = describeNetwork(proxied);
    assert.equal(net.port, 8096);
    assert.equal(net.effectiveBaseUrl, 'https://mon-nas.synology.me');
    assert.equal(net.requestOrigin, 'https://mon-nas.synology.me');
    assert.equal(net.behindReverseProxy, true);
    assert.equal(net.publicUrlIsPrivate, false);
    assert.equal(net.mobileLoginUrl, 'https://mon-nas.synology.me/login.html');
    assert.ok(net.qrUrl.startsWith('/api/qr?text='));
    assert.ok(net.shareUrlExample.startsWith('https://mon-nas.synology.me/s/'));
    assert.ok(net.localUrl.startsWith('http://'));
    assert.equal(net.savedPublicBaseUrl, null);
    assert.equal(net.guide.length, 3);
    assert.equal(net.guide[0].recommended, true);
    for (const step of net.guide) {
      assert.ok(step.title.length > 10);
      assert.ok(step.steps.length >= 3);
    }
    assert.equal(EXTERNAL_ACCESS_GUIDE.length, 3);
    assert.match(EXTERNAL_ACCESS_GUIDE[0].steps.join(' '), /Proxy inversé|proxy inversé/);
    assert.match(EXTERNAL_ACCESS_GUIDE[2].steps.join(' '), /Tailscale/);
    assert.match(EXTERNAL_ACCESS_GUIDE[2].steps.join(' '), /cloudflared/);
    assert.equal(isIPv4('82.64.10.20'), true);
    assert.equal(isIPv4('999.1.1.1'), false);
  });

  it('warns that the effective URL is private when only the LAN is reachable', async () => {
    const { describeNetwork } = await import('../src/net/network');
    const net = describeNetwork(fakeReq({ host: '192.168.1.42:8096' }));
    assert.equal(net.effectiveBaseUrl, 'http://192.168.1.42:8096');
    assert.equal(net.publicUrlIsPrivate, true);
    assert.ok(net.warnings.some((w) => /privée/i.test(w)));
  });
});
