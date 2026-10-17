import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamToken,
  resolveStreamToken,
  buildRawStreamUrl,
  buildM3uContent,
  buildShareRawStreamUrl,
  buildMultiM3uContent,
  _clearStreamTokensForTests,
} from '../src/auth/streamTokens';

describe('stream tokens + URL helpers', () => {
  beforeEach(() => {
    _clearStreamTokensForTests();
  });

  it('creates and resolves raw tokens', () => {
    const tok = createStreamToken({ mediaId: 42, userId: 1, scope: 'raw' });
    assert.ok(tok.length >= 32);
    const data = resolveStreamToken(tok, { mediaId: 42, scope: 'raw' });
    assert.ok(data);
    assert.equal(data!.mediaId, 42);
    assert.equal(resolveStreamToken(tok, { mediaId: 99 }), null);
    assert.equal(resolveStreamToken('deadbeef', { mediaId: 42 }), null);
  });

  it('raw token works for download and hls scopes', () => {
    const tok = createStreamToken({ mediaId: 7, scope: 'raw' });
    assert.ok(resolveStreamToken(tok, { mediaId: 7, scope: 'download' }));
    assert.ok(resolveStreamToken(tok, { mediaId: 7, scope: 'hls' }));
  });

  it('download scope does not unlock hls', () => {
    const tok = createStreamToken({ mediaId: 7, scope: 'download' });
    assert.ok(resolveStreamToken(tok, { mediaId: 7, scope: 'download' }));
    assert.equal(resolveStreamToken(tok, { mediaId: 7, scope: 'hls' }), null);
  });

  it('builds raw stream and m3u content', () => {
    const url = buildRawStreamUrl(3, 'abc123');
    assert.ok(url.includes('/api/stream/3/raw?token=abc123'));
    const m3u = buildM3uContent('My Film', url);
    assert.ok(m3u.startsWith('#EXTM3U'));
    assert.ok(m3u.includes('My Film'));
    assert.ok(m3u.includes(url));
  });

  it('builds share stream URL with an optional signed access token (never a password)', () => {
    const u1 = buildShareRawStreamUrl('sharetok');
    assert.ok(u1.includes('/api/public/stream/sharetok'));
    assert.equal(u1.includes('?'), false);
    const u2 = buildShareRawStreamUrl('sharetok', 'v1.abc.sig');
    assert.ok(u2.includes('access=v1.abc.sig'));
    assert.equal(u2.includes('password='), false);
    const u3 = buildShareRawStreamUrl('sharetok', undefined, 42, 'https://media.example');
    assert.ok(u3.includes('/api/public/share/sharetok/item/42/stream'));
  });

  it('builds multi-entry m3u playlists', () => {
    const m3u = buildMultiM3uContent([
      { title: 'A', streamUrl: 'http://x/a' },
      { title: 'B', streamUrl: 'http://x/b' },
    ]);
    assert.ok(m3u.startsWith('#EXTM3U'));
    assert.equal((m3u.match(/#EXTINF/g) || []).length, 2);
    assert.ok(m3u.includes('http://x/a'));
    assert.ok(m3u.includes('http://x/b'));
  });

  it('sanitizes newlines in m3u titles', () => {
    const m3u = buildM3uContent('Bad\nTitle\rX', 'http://x');
    assert.equal(m3u.includes('\nBad'), false);
    assert.ok(m3u.includes('Bad Title X') || m3u.includes('Bad Title'));
  });
});
