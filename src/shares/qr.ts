import type { Request } from 'express';
import QRCode from 'qrcode';
import { config } from '../config';
import { getDb } from '../db/schema';

const PUBLIC_BASE_URL_KEY = 'public_base_url';
const MAX_QR_TEXT = 2048;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 0) return host.slice(1, end);
  }
  return host.split(':')[0] || host;
}

export function isLoopbackHost(host: string): boolean {
  const hostname = hostnameOf(host).toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return isLoopbackHost(u.hostname);
  } catch {
    return true;
  }
}

function bareHostname(host: string): string {
  return hostnameOf(host)
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^::ffff:/, ''); // IPv4-mapped IPv6 (Node reports ::ffff:192.168.x.x)
}

/**
 * True for addresses that only work on the local network: localhost, RFC1918
 * (192.168.x.x / 10.x.x.x / 172.16–31.x.x), link-local, mDNS/`.local` names and
 * IPv6 ULA. Share links built on such a host will not work over 4G/5G.
 */
export function isPrivateHost(host: string): boolean {
  const h = bareHostname(host || '');
  if (!h) return true;
  if (isLoopbackHost(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home')) {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // IPv4 link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // CGNAT (Tailscale)
  if (/^fe80:/i.test(h)) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique local
  return false;
}

export function isPrivateUrl(raw: string): boolean {
  try {
    return isPrivateHost(new URL(raw).hostname);
  } catch {
    return true;
  }
}

export async function generateQrSvg(text: string): Promise<string> {
  if (!(text.length > 0 && text.length <= MAX_QR_TEXT)) {
    throw new Error('Texte QR invalide (1–2048 caractères)');
  }
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 260,
    color: { dark: '#0f1115', light: '#ffffff' },
  });
}

export function getCustomPublicBaseUrl(): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM scan_meta WHERE key = ?`)
    .get(PUBLIC_BASE_URL_KEY) as { value: string } | undefined;
  const v = row?.value?.trim();
  return v ? stripTrailingSlash(v) : null;
}

export function setCustomPublicBaseUrl(rawUrl: string | null): string | null {
  const db = getDb();
  if (rawUrl == null || String(rawUrl).trim() === '') {
    db.prepare(`DELETE FROM scan_meta WHERE key = ?`).run(PUBLIC_BASE_URL_KEY);
    return null;
  }
  const trimmed = stripTrailingSlash(String(rawUrl).trim());
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('URL publique invalide');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL publique invalide (http ou https requis)');
  }
  db.prepare(
    `INSERT INTO scan_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(PUBLIC_BASE_URL_KEY, trimmed);
  return trimmed;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').split(',')[0].trim();
}

/** RFC 7239 `Forwarded: for=1.2.3.4;proto=https;host=nas.example.com` (first hop). */
export function parseForwardedHeader(raw: string | undefined): { proto?: string; host?: string } {
  if (!raw) return {};
  const first = String(raw).split(',')[0];
  const out: { proto?: string; host?: string } = {};
  for (const part of first.split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    const key = k.trim().toLowerCase();
    const value = v.trim().replace(/^"|"$/g, '');
    if (!value) continue;
    if (key === 'proto') out.proto = value;
    if (key === 'host') out.host = value;
  }
  return out;
}

/** Headers set by the DSM reverse proxy / Cloudflare Tunnel / nginx. */
export interface ForwardedInfo {
  proto: string | null;
  host: string | null;
  forwardedFor: string | null;
  behindProxy: boolean;
}

export function forwardedInfo(req?: Request): ForwardedInfo {
  if (!req) return { proto: null, host: null, forwardedFor: null, behindProxy: false };
  const std = parseForwardedHeader(
    (Array.isArray(req.headers.forwarded) ? req.headers.forwarded[0] : req.headers.forwarded) as
      | string
      | undefined
  );
  const protoHeader = firstHeaderValue(req.headers['x-forwarded-proto']) || std.proto || null;
  const hostHeader = firstHeaderValue(req.headers['x-forwarded-host']) || std.host || null;
  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']) || null;
  return {
    proto: protoHeader,
    host: hostHeader,
    forwardedFor,
    behindProxy: !!(protoHeader || hostHeader || req.headers['x-forwarded-for'] || req.headers.forwarded),
  };
}

/**
 * Public origin of the current request, honoring Reverse Proxy headers
 * (`X-Forwarded-Proto` / `X-Forwarded-Host`, and RFC 7239 `Forwarded`).
 * Returns e.g. `https://mon-nas.synology.me`.
 */
export function originFromRequest(req?: Request): string | null {
  if (!req) return null;
  const fwd = forwardedInfo(req);
  const proto = (fwd.proto || req.protocol || 'http').toLowerCase();
  const host = fwd.host || req.get('host') || '';
  if (!host) return null;
  // Drop the port when it is the default one for the scheme (https://host:443).
  const port = /:(\d+)$/.exec(host)?.[1];
  const defaultPort =
    (proto === 'https' && (port === '443' || port === '80')) ||
    (proto === 'http' && port === '80');
  const normalizedHost = port && defaultPort ? host.replace(/:\d+$/, '') : host;
  return `${proto}://${normalizedHost}`;
}

/**
 * Resolve the public base URL used in share / VLC / QR links.
 * 1. Admin-saved `public_base_url` in SQLite
 * 2. `config.PUBLIC_BASE_URL` if it is not localhost
 * 3. Request origin (X-Forwarded-Proto / X-Forwarded-Host aware) if not localhost
 * 4. `config.PUBLIC_BASE_URL` fallback
 */
export function resolvePublicBaseUrl(req?: Request): string {
  const custom = getCustomPublicBaseUrl();
  if (custom) return custom;

  const configured = stripTrailingSlash(config.PUBLIC_BASE_URL);
  if (configured && !isLoopbackUrl(configured)) return configured;

  const fromReq = originFromRequest(req);
  if (fromReq && !isLoopbackUrl(fromReq)) return stripTrailingSlash(fromReq);

  return configured || `http://localhost:${config.PORT}`;
}

export function qrApiUrl(text: string): string {
  return '/api/qr?text=' + encodeURIComponent(text);
}
