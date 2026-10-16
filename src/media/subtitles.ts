import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../config';
import type { MediaItem } from '../db/schema';
import { ensureProbeForItem } from './probe';

/**
 * Embedded subtitle extraction to WebVTT (Plex-like subtitle selection).
 *
 * Text subtitles (SRT/ASS/MOV_TEXT…) are extracted on demand with ffmpeg and
 * cached in DATA_PATH/cache/subs. Image subtitles (PGS/VobSub) cannot be
 * converted to text and are reported as unavailable.
 */

const inflight = new Map<string, Promise<string | null>>();

function subName(item: MediaItem, index: number): string {
  return `${item.id}-s${index}-${item.mtime}-${item.size_bytes}.vtt`;
}

function extractVtt(absPath: string, subIndex: number, outPath: string, timeoutMs: number): Promise<boolean> {
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
          '-i',
          absPath,
          '-map',
          `0:s:${subIndex}`,
          '-c:s',
          'webvtt',
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

export interface SubtitleAvailability {
  ok: boolean;
  reason?: string;
}

/** Check whether a subtitle track can be served as WebVTT. */
export async function checkSubtitle(item: MediaItem, index: number): Promise<SubtitleAvailability> {
  const probe = await ensureProbeForItem(item);
  if (!probe) return { ok: false, reason: 'Analyse des sous-titres indisponible' };
  const sub = probe.subtitles.find((s) => s.index === index);
  if (!sub) return { ok: false, reason: 'Sous-titre introuvable' };
  if (sub.imageBased) {
    return { ok: false, reason: 'Sous-titre image (PGS/VobSub) — lecture dans VLC uniquement' };
  }
  return { ok: true };
}

/** Ensure the WebVTT file exists. Returns the path or null. */
export function ensureSubtitleVtt(item: MediaItem, index: number): Promise<string | null> {
  const name = subName(item, index);
  const outPath = path.join(config.SUBTITLE_CACHE_PATH, name);
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);
  const existing = inflight.get(name);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    try {
      const avail = await checkSubtitle(item, index);
      if (!avail.ok) return null;
      fs.mkdirSync(config.SUBTITLE_CACHE_PATH, { recursive: true });
      const ok = await extractVtt(item.path, index, outPath, 90000);
      if (ok) return outPath;
      try {
        fs.unlinkSync(outPath);
      } catch {}
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
