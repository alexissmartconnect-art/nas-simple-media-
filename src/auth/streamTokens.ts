import crypto from 'crypto';
import { config } from '../config';

export type StreamTokenScope = 'raw' | 'download' | 'hls';

export type StreamTokenData = {
  mediaId: number;
  userId: number | null;
  shareToken: string | null;
  scope: StreamTokenScope;
  created: number;
  expires: number;
};

const tokens = new Map<string, StreamTokenData>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of tokens.entries()) {
    if (v.expires <= now) tokens.delete(k);
  }
}

/** Create a short-lived token for VLC / external players (no cookie). */
export function createStreamToken(opts: {
  mediaId: number;
  userId?: number | null;
  shareToken?: string | null;
  scope?: StreamTokenScope;
  ttlMs?: number;
}): string {
  prune();
  const token = crypto.randomBytes(24).toString('hex');
  const ttl = opts.ttlMs ?? config.STREAM_TOKEN_TTL_MS;
  tokens.set(token, {
    mediaId: opts.mediaId,
    userId: opts.userId ?? null,
    shareToken: opts.shareToken ?? null,
    scope: opts.scope || 'raw',
    created: Date.now(),
    expires: Date.now() + ttl,
  });
  return token;
}

/**
 * Resolve a stream token. A `raw` token is accepted for raw/download/hls.
 * Narrower scopes only match themselves.
 */
export function resolveStreamToken(
  token: string | undefined,
  opts?: { mediaId?: number; scope?: StreamTokenScope | StreamTokenScope[] }
): StreamTokenData | null {
  if (!token) return null;
  prune();
  const data = tokens.get(token);
  if (!data) return null;
  if (data.expires <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  if (opts?.mediaId != null && data.mediaId !== opts.mediaId) return null;
  if (opts?.scope) {
    const wanted = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
    const ok =
      wanted.includes(data.scope) ||
      (data.scope === 'raw' && wanted.some((s) => s === 'raw' || s === 'download' || s === 'hls'));
    if (!ok) return null;
  }
  return data;
}

export function buildRawStreamUrl(mediaId: number, token: string): string {
  return `${config.PUBLIC_BASE_URL}/api/stream/${mediaId}/raw?token=${encodeURIComponent(token)}`;
}

export function buildShareRawStreamUrl(shareToken: string, password?: string): string {
  let url = `${config.PUBLIC_BASE_URL}/api/public/stream/${encodeURIComponent(shareToken)}`;
  if (password) url += `?password=${encodeURIComponent(password)}`;
  return url;
}

export function buildM3uContent(title: string, streamUrl: string): string {
  const safeTitle = String(title || 'media').replace(/[\r\n]/g, ' ');
  return `#EXTM3U\n#EXTINF:-1,${safeTitle}\n${streamUrl}\n`;
}

/** Test helper — clear all tokens. */
export function _clearStreamTokensForTests(): void {
  tokens.clear();
}
