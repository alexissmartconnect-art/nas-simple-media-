import path from 'path';
import fs from 'fs';

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
const SESSION_SECRET = process.env.SESSION_SECRET || `nas-sm-${ADMIN_PASSWORD}-session`;

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
fs.mkdirSync(MEDIA_PATH, { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'transcode'), { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'thumbs'), { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'subs'), { recursive: true });

export const config = {
  MEDIA_PATH,
  DATA_PATH,
  PORT,
  ADMIN_PASSWORD,
  PUBLIC_BASE_URL,
  SESSION_SECRET,
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
