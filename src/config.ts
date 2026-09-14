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
const TRANSCODE_MAX_JOBS = Math.max(1, parseInt(process.env.TRANSCODE_MAX_JOBS || '1', 10) || 1);
const TRANSCODE_CACHE_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.TRANSCODE_CACHE_TTL_MS || String(2 * 60 * 60 * 1000), 10) || 2 * 60 * 60 * 1000
);
const STREAM_TOKEN_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.STREAM_TOKEN_TTL_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000
);

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(MEDIA_PATH, { recursive: true });
fs.mkdirSync(path.join(DATA_PATH, 'cache', 'transcode'), { recursive: true });

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
  TRANSCODE_MAX_JOBS,
  TRANSCODE_CACHE_TTL_MS,
  STREAM_TOKEN_TTL_MS,
  TRANSCODE_CACHE_PATH: path.join(DATA_PATH, 'cache', 'transcode'),
};

export type MediaType = 'movie' | 'episode' | 'track';
export type LibraryKind = 'movies' | 'series' | 'music';

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.m4v']);
export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.opus', '.wav']);

// silence unused helper in some builds
void env;
