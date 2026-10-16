import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../config';
import type { MediaItem } from '../db/schema';
import { getCachedProbe } from './probe';

/**
 * Video thumbnails (Plex-like posters).
 *
 * Extracts a single frame with ffmpeg, cached in DATA_PATH/cache/thumbs as
 * `<id>-<mtime>-<size>.jpg` so stale thumbs are naturally invalidated when
 * the file changes. Best-effort: returns null when ffmpeg is missing or the
 * extraction fails (the UI falls back to an icon).
 */

const inflight = new Map<string, Promise<string | null>>();

function thumbName(item: MediaItem): string {
  return `${item.id}-${item.mtime}-${item.size_bytes}.jpg`;
}

function extractFrame(absPath: string, outPath: string, seekSec: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        config.FFMPEG_PATH,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          String(seekSec),
          '-i',
          absPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=320:-1',
          '-q:v',
          '4',
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    proc.on('error', () => finish(false));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) finish(true);
      else finish(false);
    });
  });
}

function preferredSeekSec(item: MediaItem): number {
  try {
    const probe = getCachedProbe(item);
    if (probe?.durationMs && probe.durationMs > 30000) {
      return Math.min(600, Math.max(10, Math.floor(probe.durationMs / 1000 / 10)));
    }
  } catch {}
  return 120;
}

/** Ensure a thumbnail exists for this video item. Returns the file path or null. */
export function ensureThumb(item: MediaItem): Promise<string | null> {
  if (!config.THUMBS_ENABLED) return Promise.resolve(null);
  if (item.type === 'track') return Promise.resolve(null);
  const name = thumbName(item);
  const outPath = path.join(config.THUMB_CACHE_PATH, name);
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);

  const existing = inflight.get(name);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    try {
      fs.mkdirSync(config.THUMB_CACHE_PATH, { recursive: true });
      // Clean older thumbs for the same media id
      try {
        for (const f of fs.readdirSync(config.THUMB_CACHE_PATH)) {
          if (f.startsWith(`${item.id}-`) && f !== name) {
            try {
              fs.unlinkSync(path.join(config.THUMB_CACHE_PATH, f));
            } catch {}
          }
        }
      } catch {}

      const seeks = [preferredSeekSec(item), 10, 0];
      for (const s of seeks) {
        const ok = await extractFrame(item.path, outPath, s, 30000);
        if (ok) return outPath;
        try {
          fs.unlinkSync(outPath);
        } catch {}
      }
      return null;
    } catch {
      return null;
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, p);
  return p;
}

export function thumbCacheKey(item: MediaItem): string {
  return `"thumb-${item.id}-${item.mtime}-${item.size_bytes}"`;
}
