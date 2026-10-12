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

function originFromRequest(req?: Request): string | null {
  if (!req) return null;
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = String(
    (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || req.protocol || 'http'
  )
    .split(',')[0]
    .trim();
  const hostHeader = req.headers['x-forwarded-host'];
  const host = String(
    (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || req.get('host') || ''
  )
    .split(',')[0]
    .trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

/**
 * Resolve the public base URL used in share / VLC / QR links.
 * 1. Admin-saved `public_base_url` in SQLite
 * 2. `config.PUBLIC_BASE_URL` if it is not localhost
 * 3. Request origin (forwarded proto/host) if it is not localhost
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
