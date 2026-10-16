import { spawn } from 'child_process';
import { config } from '../config';
import { getDb, type MediaItem } from '../db/schema';

/**
 * Media probing (ffprobe) — Plex-like media info.
 *
 * Detects the REAL codecs inside containers instead of guessing from the
 * extension: DTS / DTS-HD MA / TrueHD / AC-3 / E-AC-3 / FLAC / AAC / Opus,
 * channel layouts (stereo / 5.1 / 7.1), video codec, resolution, HDR…
 *
 * Results are cached in SQLite (media_probe) keyed by file mtime+size so a
 * weak Synology CPU only pays the probe cost once per file.
 */

export interface ProbeVideoStream {
  index: number;
  codec: string; // h264, hevc, vp9, av1, mpeg4, mjpeg…
  profile?: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  pixFmt?: string;
  hdr: boolean;
}

export interface ProbeAudioStream {
  index: number; // index among AUDIO streams (0-based, for -map 0:a:N)
  streamIndex: number; // absolute stream index in the file
  codec: string; // dts, truehd, ac3, eac3, aac, flac, opus, mp3…
  profile?: string; // e.g. "DTS-HD MA", "DTS-ES"
  channels: number;
  channelLayout?: string;
  sampleRate: number | null;
  bitrate: number | null;
  language?: string;
  title?: string;
  isDefault: boolean;
}

export interface ProbeSubtitleStream {
  index: number; // index among SUBTITLE streams (0-based, for -map 0:s:N)
  streamIndex: number;
  codec: string; // subrip, ass, mov_text, pgs…
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  imageBased: boolean; // PGS/VobSub cannot be extracted to WebVTT text
}

export interface MediaProbe {
  container: string; // file extension
  formatName?: string;
  durationMs: number | null;
  sizeBytes: number | null;
  bitrate: number | null;
  video: ProbeVideoStream[];
  audio: ProbeAudioStream[];
  subtitles: ProbeSubtitleStream[];
  probedAt: string;
}

export interface ProbeSummary {
  videoLabel: string | null; // "HEVC 4K HDR", "H.264 1080p"
  audioLabels: string[]; // ["DTS-HD MA 5.1", "AC-3 Stéréo"]
  subtitleLabels: string[]; // ["Français (SRT)", "English (PGS)"]
  hasVideo: boolean;
  hasAudio: boolean;
  hasSurround: boolean; // ≥ 1 audio track with 6+ channels
  hasDts: boolean; // DTS / DTS-HD / DTS:X family
  hasTrueHd: boolean;
  hasHdr: boolean;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  audioTracks: number;
  subtitleTracks: number;
  textSubtitleTracks: number;
}

// ---------------------------------------------------------------------------
// ffprobe execution
// ---------------------------------------------------------------------------

function runFfprobe(absPath: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(
        config.FFPROBE_PATH,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          absPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(new Error(`ffprobe timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
      if (stdout.length > 2_000_000) {
        try {
          proc.kill('SIGKILL');
        } catch {}
        finish(new Error('ffprobe output too large'));
      }
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    proc.on('error', (e) => finish(e));
    proc.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim().split('\n').pop() || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout || '{}'));
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Parsing / normalization
// ---------------------------------------------------------------------------

type RawStream = Record<string, unknown>;
type RawFormat = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function parseFps(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(v));
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b > 0) return a / b;
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isHdrStream(s: RawStream): boolean {
  const colorTrc = String(s.color_transfer || '');
  const pixFmt = String(s.pix_fmt || '');
  if (colorTrc === 'smpte2084' || colorTrc === 'arib-std-b67') return true;
  if (/p010|p016|yuv420p1[02]|yuv444p1[02]/i.test(pixFmt)) {
    // 10-bit alone is not HDR, but combined with HEVC/VP9 it's a strong hint
    const codec = String(s.codec_name || '').toLowerCase();
    if (codec === 'hevc' || codec === 'vp9' || codec === 'av1') return true;
  }
  return false;
}

const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** Parse raw ffprobe JSON into a normalized MediaProbe. Pure function — unit tested. */
export function parseFfprobeJson(raw: unknown, containerExt: string): MediaProbe {
  const obj = (raw || {}) as { streams?: RawStream[]; format?: RawFormat };
  const streams = Array.isArray(obj.streams) ? obj.streams : [];
  const format = obj.format || {};

  const probe: MediaProbe = {
    container: containerExt.toLowerCase(),
    formatName: str(format.format_name),
    durationMs: num(format.duration) != null ? Math.round((num(format.duration) as number) * 1000) : null,
    sizeBytes: num(format.size),
    bitrate: num(format.bit_rate),
    video: [],
    audio: [],
    subtitles: [],
    probedAt: new Date().toISOString(),
  };

  let audioIdx = 0;
  let subIdx = 0;
  let videoIdx = 0;
  for (const s of streams) {
    const type = String(s.codec_type || '');
    const codec = String(s.codec_name || 'unknown').toLowerCase();
    const absIndex = num(s.index) ?? 0;
    const tags = (s.tags || {}) as Record<string, unknown>;
    const disp = (s.disposition || {}) as Record<string, unknown>;
    if (type === 'video') {
      // Skip attached pictures (album art) — not a real video track
      if (disp.attached_pic === 1) continue;
      probe.video.push({
        index: videoIdx++,
        codec,
        profile: str(s.profile),
        width: num(s.width),
        height: num(s.height),
        fps: parseFps(s.avg_frame_rate) ?? parseFps(s.r_frame_rate),
        bitrate: num(s.bit_rate),
        pixFmt: str(s.pix_fmt),
        hdr: isHdrStream(s),
      });
    } else if (type === 'audio') {
      probe.audio.push({
        index: audioIdx++,
        streamIndex: absIndex,
        codec,
        profile: str(s.profile),
        channels: num(s.channels) ?? 2,
        channelLayout: str(s.channel_layout),
        sampleRate: num(s.sample_rate),
        bitrate: num(s.bit_rate),
        language: str(tags.language) || str(s.language),
        title: str(tags.title),
        isDefault: disp.default === 1,
      });
    } else if (type === 'subtitle') {
      probe.subtitles.push({
        index: subIdx++,
        streamIndex: absIndex,
        codec,
        language: str(tags.language) || str(s.language),
        title: str(tags.title),
        isDefault: disp.default === 1,
        isForced: disp.forced === 1,
        imageBased: IMAGE_SUB_CODECS.has(codec),
      });
    }
  }
  return probe;
}

// ---------------------------------------------------------------------------
// Labels (Plex-style badges)
// ---------------------------------------------------------------------------

export function audioCodecLabel(codec: string, profile?: string): string {
  const c = codec.toLowerCase();
  const p = (profile || '').toUpperCase();
  switch (c) {
    case 'dts':
      if (p.includes('DTS-HD MA') || p.includes('MA')) return 'DTS-HD MA';
      if (p.includes('DTS:X') || p.includes('DTS-X')) return 'DTS:X';
      if (p.includes('EXPRESS') || p.includes('DTS-HD HRA')) return 'DTS-HD HRA';
      if (p.includes('ES')) return 'DTS-ES';
      if (p.includes('96/24')) return 'DTS 96/24';
      return 'DTS';
    case 'dts-hd':
    case 'dtshd':
      return 'DTS-HD MA';
    case 'truehd':
      return 'TrueHD';
    case 'ac3':
      return 'AC-3';
    case 'eac3':
      return 'E-AC-3';
    case 'aac':
      if (p.includes('HE')) return 'HE-AAC';
      return 'AAC';
    case 'flac':
      return 'FLAC';
    case 'opus':
      return 'Opus';
    case 'vorbis':
      return 'Vorbis';
    case 'mp3':
    case 'mp2':
      return 'MP3';
    case 'pcm_s16le':
    case 'pcm_s24le':
    case 'pcm_s32le':
    case 'pcm_f32le':
    case 'alac':
      return 'PCM';
    case 'wmapro':
    case 'wmav2':
      return 'WMA';
    default:
      return codec.toUpperCase();
  }
}

export function channelLabel(channels: number): string {
  if (channels <= 1) return 'Mono';
  if (channels === 2) return 'Stéréo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  if (channels > 8) return `${channels} canaux`;
  return `${channels}.0`;
}

export function audioTrackLabel(a: ProbeAudioStream): string {
  const codec = audioCodecLabel(a.codec, a.profile);
  const ch = channelLabel(a.channels);
  const lang = a.language ? ` · ${a.language.toUpperCase()}` : '';
  const title = a.title ? ` — ${a.title}` : '';
  return `${codec} ${ch}${lang}${title}`;
}

export function videoCodecLabel(codec: string): string {
  switch (codec.toLowerCase()) {
    case 'h264':
      return 'H.264';
    case 'hevc':
    case 'h265':
      return 'HEVC';
    case 'av1':
      return 'AV1';
    case 'vp9':
      return 'VP9';
    case 'mpeg4':
      return 'MPEG-4';
    case 'mpeg2video':
    case 'mpeg2':
      return 'MPEG-2';
    case 'vc1':
      return 'VC-1';
    case 'mjpeg':
      return 'MJPEG';
    case 'theora':
      return 'Theora';
    default:
      return codec.toUpperCase();
  }
}

export function resolutionLabel(width: number | null, height: number | null): string | null {
  const h = height ?? 0;
  const w = width ?? 0;
  if (h >= 2000 || w >= 3800) return '4K';
  if (h >= 1000 || w >= 1900) return '1080p';
  if (h >= 700 || w >= 1250) return '720p';
  if (h >= 470 || w >= 700) return '480p';
  if (h > 0) return `${h}p`;
  return null;
}

export function videoTrackLabel(v: ProbeVideoStream): string {
  const parts = [videoCodecLabel(v.codec)];
  const res = resolutionLabel(v.width, v.height);
  if (res) parts.push(res);
  if (v.hdr) parts.push('HDR');
  return parts.join(' ');
}

const SUB_CODEC_LABELS: Record<string, string> = {
  subrip: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  mov_text: 'MOV_TEXT',
  webvtt: 'VTT',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
};

export function subtitleTrackLabel(s: ProbeSubtitleStream): string {
  const codec = SUB_CODEC_LABELS[s.codec] || s.codec.toUpperCase();
  const forced = s.isForced ? ' (forcé)' : '';
  const title = s.title ? ` — ${s.title}` : '';
  if (!s.language) return `${codec}${forced}${title}`;
  return `${s.language.toUpperCase()} (${codec})${forced}${title}`;
}

export function isDtsFamily(codec: string): boolean {
  return codec.toLowerCase().startsWith('dts');
}

export function isLosslessSurroundCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === 'truehd' || c === 'flac' || c === 'alac' || c.startsWith('pcm');
}

/** Compact summary for API responses and UI badges. Pure function — unit tested. */
export function summarizeProbe(probe: MediaProbe): ProbeSummary {
  const v0 = probe.video[0];
  return {
    videoLabel: v0 ? videoTrackLabel(v0) : null,
    audioLabels: probe.audio.map(audioTrackLabel),
    subtitleLabels: probe.subtitles.map(subtitleTrackLabel),
    hasVideo: probe.video.length > 0,
    hasAudio: probe.audio.length > 0,
    hasSurround: probe.audio.some((a) => a.channels >= 6),
    hasDts: probe.audio.some((a) => isDtsFamily(a.codec)),
    hasTrueHd: probe.audio.some((a) => a.codec.toLowerCase() === 'truehd'),
    hasHdr: probe.video.some((v) => v.hdr),
    width: v0?.width ?? null,
    height: v0?.height ?? null,
    durationMs: probe.durationMs,
    audioTracks: probe.audio.length,
    subtitleTracks: probe.subtitles.length,
    textSubtitleTracks: probe.subtitles.filter((s) => !s.imageBased).length,
  };
}

// ---------------------------------------------------------------------------
// Cache (SQLite + in-memory hot cache)
// ---------------------------------------------------------------------------

const memCache = new Map<number, { mtime: number; size: number; probe: MediaProbe }>();
const MEM_CACHE_MAX = 300;

function memGet(mediaId: number, mtime: number, size: number): MediaProbe | null {
  const e = memCache.get(mediaId);
  if (e && e.mtime === mtime && e.size === size) return e.probe;
  return null;
}

function memSet(mediaId: number, mtime: number, size: number, probe: MediaProbe): void {
  if (memCache.size >= MEM_CACHE_MAX) {
    const first = memCache.keys().next().value;
    if (first !== undefined) memCache.delete(first);
  }
  memCache.set(mediaId, { mtime, size, probe });
}

export function getCachedProbe(item: MediaItem): MediaProbe | null {
  const mem = memGet(item.id, item.mtime, item.size_bytes);
  if (mem) return mem;
  try {
    const row = getDb()
      .prepare('SELECT probe_json, mtime, size_bytes FROM media_probe WHERE media_id = ?')
      .get(item.id) as { probe_json: string; mtime: number; size_bytes: number } | undefined;
    if (!row) return null;
    if (row.mtime !== item.mtime || row.size_bytes !== item.size_bytes) return null;
    const probe = JSON.parse(row.probe_json) as MediaProbe;
    memSet(item.id, item.mtime, item.size_bytes, probe);
    return probe;
  } catch {
    return null;
  }
}

export function saveProbe(item: MediaItem, probe: MediaProbe): void {
  memSet(item.id, item.mtime, item.size_bytes, probe);
  try {
    getDb()
      .prepare(
        `INSERT INTO media_probe (media_id, probe_json, mtime, size_bytes, probed_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(media_id) DO UPDATE SET
           probe_json = excluded.probe_json,
           mtime = excluded.mtime,
           size_bytes = excluded.size_bytes,
           probed_at = excluded.probed_at`
      )
      .run(item.id, JSON.stringify(probe), item.mtime, item.size_bytes);
  } catch {
    /* cache is best-effort */
  }
}

export function invalidateProbe(mediaId: number): void {
  memCache.delete(mediaId);
  try {
    getDb().prepare('DELETE FROM media_probe WHERE media_id = ?').run(mediaId);
  } catch {}
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export async function probeFile(absPath: string, containerExt: string): Promise<MediaProbe> {
  const raw = await runFfprobe(absPath, config.PROBE_TIMEOUT_MS);
  return parseFfprobeJson(raw, containerExt);
}

/** Probe synchronously (async) with cache. Returns null when disabled/failed. */
export async function ensureProbeForItem(item: MediaItem): Promise<MediaProbe | null> {
  const cached = getCachedProbe(item);
  if (cached) return cached;
  if (!config.PROBE_ENABLED) return null;
  try {
    const ext = (item.filename || item.path).split('.').pop() || '';
    const probe = await probeFile(item.path, '.' + ext);
    saveProbe(item, probe);
    return probe;
  } catch {
    return null;
  }
}

// Background probe queue — trickle-probes the library without blocking the
// scanner or playback (concurrency 1, only when explicitly enabled or asked).
const bgQueue: number[] = [];
let bgRunning = false;

async function pumpBgQueue(): Promise<void> {
  if (bgRunning) return;
  bgRunning = true;
  try {
    while (bgQueue.length) {
      const id = bgQueue.shift()!;
      try {
        const item = getDb()
          .prepare('SELECT * FROM media_items WHERE id = ?')
          .get(id) as MediaItem | undefined;
        if (!item) continue;
        if (getCachedProbe(item)) continue;
        await ensureProbeForItem(item);
      } catch {
        /* ignore */
      }
    }
  } finally {
    bgRunning = false;
  }
}

export function enqueueBackgroundProbe(mediaId: number): void {
  if (!config.PROBE_ENABLED) return;
  if (bgQueue.includes(mediaId)) return;
  if (bgQueue.length > 2000) bgQueue.shift();
  bgQueue.push(mediaId);
  // Defer so request handlers never wait for probing.
  setImmediate(() => {
    pumpBgQueue().catch(() => {});
  });
}

export function _resetProbeForTests(): void {
  memCache.clear();
  bgQueue.length = 0;
  bgRunning = false;
}
