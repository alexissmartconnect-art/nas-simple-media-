import crypto from 'crypto';
import { config } from '../config';

/**
 * Short-lived, signed share access tokens.
 *
 * The share password is POSTed once to /api/public/share/:token/unlock and
 * exchanged for `v1.<expiry>.<hmac>`; the password itself never appears in a
 * URL again. The HMAC covers the share token, the expiry and the share's
 * password hash, so the access token is useless for another share and is
 * invalidated as soon as the share password changes (or the share is revoked /
 * expires, which resolveShare checks independently).
 */

const VERSION = 'v1';

function sign(shareToken: string, exp: number, passwordHash: string): string {
  return crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(`share-access|${shareToken}|${exp}|${passwordHash}`)
    .digest('base64url');
}

export function createShareAccessToken(
  shareToken: string,
  passwordHash: string,
  ttlMs: number = config.SHARE_ACCESS_TTL_MS,
  now: number = Date.now()
): { token: string; expiresAt: number } {
  const exp = now + ttlMs;
  return { token: `${VERSION}.${exp.toString(36)}.${sign(shareToken, exp, passwordHash)}`, expiresAt: exp };
}

export function verifyShareAccessToken(
  shareToken: string,
  passwordHash: string | null | undefined,
  accessToken: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!passwordHash || !accessToken || typeof accessToken !== 'string' || accessToken.length > 200) return false;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const exp = parseInt(parts[1], 36);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = Buffer.from(sign(shareToken, exp, passwordHash));
  const given = Buffer.from(parts[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Cookie set by the unlock endpoint for browsers (one per share, path /api/public/). */
export function shareAccessCookieName(shareToken: string): string {
  return 'nas_sm_sa_' + crypto.createHash('sha256').update(shareToken).digest('hex').slice(0, 16);
}
