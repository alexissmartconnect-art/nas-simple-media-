import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env: ${key}`);
  }
  return v;
}

const MEDIA_PATH = path.resolve(process.env.MEDIA_PATH || './media');
const DATA_PATH = path.resolve(process.env.DATA_PATH || './data');
const PORT = parseInt(process.env.PORT || '8096', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const TRANSCODE_ENABLED = process.env.TRANSCODE_ENABLED !== 'false' && process.env.TRANSCODE_ENABLED !== '0';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const TRANSCODE_MAX_JOBS = Math.max(1, parseInt(process.env.TRANSCODE_MAX_JOBS || '1', 10) || 1);
const TRANSCODE_CACHE_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.TRANSCODE_CACHE_TTL_MS || String(2 * 60 * 60 * 1000), 10) || 2 * 60 * 60 * 1000
);
// ---- Media probing (ffprobe): detect real codecs / 5.1 / DTS like Plex ----
const PROBE_ENABLED = process.env.PROBE_ENABLED !== 'false' && process.env.PROBE_ENABLED !== '0';
const PROBE_ON_SCAN = process.env.PROBE_ON_SCAN === '1' || process.env.PROBE_ON_SCAN === 'true';
const PROBE_TIMEOUT_MS = Math.max(
  2000,
  parseInt(process.env.PROBE_TIMEOUT_MS || '15000', 10) || 15000
);
// ---- Transcode engine (Plex-like: Direct Stream + Surround profiles) ----
const TRANSCODE_HWACCEL = (process.env.TRANSCODE_HWACCEL || 'none').toLowerCase();
const TRANSCODE_PRESET = process.env.TRANSCODE_PRESET || 'veryfast';
const TRANSCODE_CRF = Math.min(
  32,
  Math.max(16, parseInt(process.env.TRANSCODE_CRF || '23', 10) || 23)
);
// Copy (remux) video without re-encoding when the codec is HLS-friendly (Direct Stream).
const TRANSCODE_VIDEO_COPY =
  process.env.TRANSCODE_VIDEO_COPY !== 'false' && process.env.TRANSCODE_VIDEO_COPY !== '0';
const TRANSCODE_COPY_CODECS = (process.env.TRANSCODE_COPY_CODECS || 'h264,mpeg4')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Surround: how multichannel (DTS/TrueHD/AC3/FLAC 5.1/7.1) is rendered in Compatible mode.
const TRANSCODE_SURROUND_CODEC = (process.env.TRANSCODE_SURROUND_CODEC || 'aac').toLowerCase();
const TRANSCODE_SURROUND_BITRATE = process.env.TRANSCODE_SURROUND_BITRATE || '384k';
const TRANSCODE_STEREO_BITRATE = process.env.TRANSCODE_STEREO_BITRATE || '192k';
// Allow bitstream passthrough of AC-3/E-AC-3 in HLS when the client asks for it
// (Safari / Apple TV only — Chrome/Firefox cannot decode AC-3).
const TRANSCODE_AUDIO_PASSTHROUGH =
  process.env.TRANSCODE_AUDIO_PASSTHROUGH === '1' || process.env.TRANSCODE_AUDIO_PASSTHROUGH === 'true';
const TRANSCODE_VAAPI_DEVICE = process.env.TRANSCODE_VAAPI_DEVICE || '/dev/dri/renderD128';
// ---- Thumbnails (Plex-like posters) ----
const THUMBS_ENABLED = process.env.THUMBS_ENABLED !== 'false' && process.env.THUMBS_ENABLED !== '0';
const STREAM_TOKEN_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.STREAM_TOKEN_TTL_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000
);

fs.mkdirSync(DATA_PATH, { recursive: true });
try {
  fs.accessSync(DATA_PATH, fs.constants.W_OK);
} catch {
  throw new Error(
    `DATA_PATH ${DATA_PATH} n'est pas accessible en écriture pour l'utilisateur ${
      typeof process.getuid === 'function' ? process.getuid() : '?'
    }. Docker (image non-root, uid 1000) : sudo chown -R 1000:1000 <dossier data de l'hôte>.`
  );
}
try {
  fs.mkdirSync(MEDIA_PATH, { recursive: true });
} catch {
  // On Synology DSM, the service user (sc-nas-simple-media) only has read access
  // to shared folders and cannot create directories under /volume1.
}
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'transcode'), { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'thumbs'), { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'subs'), { recursive: true });

/**
 * Secret used to sign short-lived share access tokens (and any other HMAC).
 * If SESSION_SECRET is not provided, a random 256-bit secret is generated once
 * and stored in DATA_PATH/session.secret (mode 600) so it survives restarts.
 * It is never derived from ADMIN_PASSWORD any more.
 */
export function loadOrCreateSessionSecret(dataPath: string, fromEnv?: string): string {
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();
  const file = path.join(dataPath, 'session.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not created yet
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort (some filesystems ignore chmod)
  }
  return secret;
}

const SESSION_SECRET = loadOrCreateSessionSecret(DATA_PATH, process.env.SESSION_SECRET);

/**
 * Express "trust proxy" setting. Only trusted hops may set X-Forwarded-For /
 * X-Forwarded-Proto, so clients on the Internet cannot spoof their IP.
 *  - TRUST_PROXY_HOPS=<n>              trust exactly n proxies in front of the app
 *  - TRUST_PROXY_HOPS=loopback,...     trust these addresses / subnets (Express syntax)
 *  - TRUST_PROXY_HOPS=0 | false        trust nobody (port exposed directly)
 *  - default: loopback, linklocal, uniquelocal (DSM reverse proxy, Docker bridge,
 *    Tailscale serve on localhost) — never "true".
 * The legacy TRUST_PROXY=0/false still disables it; TRUST_PROXY=1/true maps to the default.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';
export function parseTrustProxy(hops?: string, legacy?: string): string | number | false {
  const raw = (hops ?? '').trim();
  if (raw) {
    const low = raw.toLowerCase();
    if (low === '0' || low === 'false' || low === 'no' || low === 'off') return false;
    if (low === 'true' || low === 'yes' || low === 'on') return DEFAULT_TRUST_PROXY;
    if (/^\d+$/.test(raw)) return Math.min(10, parseInt(raw, 10));
    return raw;
  }
  const l = (legacy ?? '').trim().toLowerCase();
  if (l === '0' || l === 'false') return false;
  return DEFAULT_TRUST_PROXY;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY_HOPS, process.env.TRUST_PROXY);

function intEnv(key: string, def: number, min: number): number {
  const n = parseInt(process.env[key] || '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
}

export const config = {
  MEDIA_PATH,
  DATA_PATH,
  PORT,
  ADMIN_PASSWORD,
  PUBLIC_BASE_URL,
  SESSION_SECRET,
  TRUST_PROXY,
  /** Minimum length for new or changed passwords (existing ones keep working). */
  PASSWORD_MIN_LENGTH: intEnv('PASSWORD_MIN_LENGTH', 10, 8),
  /** Global per-IP budget on POST /api/login (requests per minute). */
  LOGIN_RATE_PER_MIN: intEnv('LOGIN_RATE_PER_MIN', 20, 1),
  /** Global per-IP budget on /api/public/* (requests per minute; HLS needs headroom). */
  PUBLIC_RATE_PER_MIN: intEnv('PUBLIC_RATE_PER_MIN', 600, 10),
  /** Per-account lockout: failures before the account is locked, and lock duration. */
  ACCOUNT_LOCK_THRESHOLD: intEnv('ACCOUNT_LOCK_THRESHOLD', 10, 3),
  ACCOUNT_LOCK_MS: intEnv('ACCOUNT_LOCK_MS', 15 * 60 * 1000, 60_000),
  /** Lifetime of the signed share access token obtained after the share password. */
  SHARE_ACCESS_TTL_MS: intEnv('SHARE_ACCESS_TTL_MS', 12 * 60 * 60 * 1000, 60_000),
  /** Transition: still accept ?password= on public share URLs (old links / old apps). */
  SHARE_PASSWORD_QUERY_COMPAT:
    process.env.SHARE_PASSWORD_QUERY_COMPAT !== '0' && process.env.SHARE_PASSWORD_QUERY_COMPAT !== 'false',
  DB_PATH: path.join(DATA_PATH, 'library.db'),
  COOKIE_NAME: 'nas_sm_session',
  SESSION_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  TRANSCODE_ENABLED,
  FFMPEG_PATH,
  FFPROBE_PATH,
  TRANSCODE_MAX_JOBS,
  TRANSCODE_CACHE_TTL_MS,
  STREAM_TOKEN_TTL_MS,
  TRANSCODE_CACHE_PATH: path.join(DATA_PATH, 'cache', 'transcode'),
  THUMB_CACHE_PATH: path.join(DATA_PATH, 'cache', 'thumbs'),
  SUBTITLE_CACHE_PATH: path.join(DATA_PATH, 'cache', 'subs'),
  PROBE_ENABLED,
  PROBE_ON_SCAN,
  PROBE_TIMEOUT_MS,
  TRANSCODE_HWACCEL,
  TRANSCODE_PRESET,
  TRANSCODE_CRF,
  TRANSCODE_VIDEO_COPY,
  TRANSCODE_COPY_CODECS,
  TRANSCODE_SURROUND_CODEC,
  TRANSCODE_SURROUND_BITRATE,
  TRANSCODE_STEREO_BITRATE,
  TRANSCODE_AUDIO_PASSTHROUGH,
  TRANSCODE_VAAPI_DEVICE,
  THUMBS_ENABLED,
};

export type MediaType = 'movie' | 'episode' | 'track';
export type LibraryKind = 'movies' | 'series' | 'music';

export const VIDEO_EXTS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.webm',
  '.m4v',
  '.mov',
  '.ts',
  '.m2ts',
  '.mpg',
  '.mpeg',
]);
export const AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.opus',
  '.wav',
  '.ogg',
  '.aac',
]);

// silence unused helper in some builds
void env;
