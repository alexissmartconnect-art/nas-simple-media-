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

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(MEDIA_PATH, { recursive: true });

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
};

export type MediaType = 'movie' | 'episode' | 'track';
export type LibraryKind = 'movies' | 'series' | 'music';

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.webm']);
export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.opus', '.wav']);
