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

/** Revoke all active stream tokens belonging to a user. */
export function revokeUserStreamTokens(userId: number): void {
  for (const [k, v] of tokens.entries()) {
    if (v.userId === userId) tokens.delete(k);
  }
}

function publicBase(baseUrl?: string): string {
  return (baseUrl || config.PUBLIC_BASE_URL).replace(/\/+$/, '');
}

export function buildRawStreamUrl(mediaId: number, token: string, baseUrl?: string): string {
  return `${publicBase(baseUrl)}/api/stream/${mediaId}/raw?token=${encodeURIComponent(token)}`;
}

export function buildShareRawStreamUrl(
  shareToken: string,
  password?: string,
  mediaId?: number,
  baseUrl?: string
): string {
  const base = publicBase(baseUrl);
  let url =
    mediaId != null
      ? `${base}/api/public/share/${encodeURIComponent(shareToken)}/item/${mediaId}/stream`
      : `${base}/api/public/stream/${encodeURIComponent(shareToken)}`;
  if (password) url += `?password=${encodeURIComponent(password)}`;
  return url;
}

export function buildM3uContent(title: string, streamUrl: string): string {
  const safeTitle = String(title || 'media').replace(/[\r\n]/g, ' ');
  return `#EXTM3U\n#EXTINF:-1,${safeTitle}\n${streamUrl}\n`;
}

export function buildMultiM3uContent(entries: Array<{ title: string; streamUrl: string }>): string {
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    const safeTitle = String(e.title || 'media').replace(/[\r\n]/g, ' ');
    lines.push(`#EXTINF:-1,${safeTitle}`);
    lines.push(e.streamUrl);
  }
  return lines.join('\n') + '\n';
}

/** Test helper — clear all tokens. */
export function _clearStreamTokensForTests(): void {
  tokens.clear();
}
