import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { config } from '../config';

export type TranscodeJobStatus = 'queued' | 'starting' | 'running' | 'ready' | 'done' | 'error' | 'idle';

type Job = {
  mediaId: number;
  inputPath: string;
  outDir: string;
  status: TranscodeJobStatus;
  error?: string;
  proc: ChildProcess | null;
  startedAt: number;
  lastAccess: number;
  ready: boolean;
};

const jobs = new Map<number, Job>();
let activeCount = 0;
const waitQueue: number[] = [];

function outDirFor(mediaId: number): string {
  return path.join(config.TRANSCODE_CACHE_PATH, String(mediaId));
}

function playlistPath(mediaId: number): string {
  return path.join(outDirFor(mediaId), 'playlist.m3u8');
}

export function isTranscodeEnabled(): boolean {
  return config.TRANSCODE_ENABLED;
}

export function getJobStatus(mediaId: number): {
  status: TranscodeJobStatus;
  ready: boolean;
  error?: string;
  enabled: boolean;
} {
  if (!config.TRANSCODE_ENABLED) {
    return { status: 'idle', ready: false, enabled: false, error: 'Transcodage désactivé' };
  }
  const job = jobs.get(mediaId);
  if (!job) {
    const pl = playlistPath(mediaId);
    if (fs.existsSync(pl)) {
      return { status: 'ready', ready: true, enabled: true };
    }
    return { status: 'idle', ready: false, enabled: true };
  }
  job.lastAccess = Date.now();
  return { status: job.status, ready: job.ready || fs.existsSync(playlistPath(mediaId)), error: job.error, enabled: true };
}

function markReadyIfPlaylist(job: Job): void {
  if (fs.existsSync(path.join(job.outDir, 'playlist.m3u8'))) {
    job.ready = true;
    if (job.status === 'starting' || job.status === 'running') {
      job.status = 'ready';
    }
  }
}

function startFfmpeg(job: Job): void {
  fs.mkdirSync(job.outDir, { recursive: true });
  // Clean previous incomplete run
  for (const f of fs.readdirSync(job.outDir)) {
    try {
      fs.unlinkSync(path.join(job.outDir, f));
    } catch {}
  }

  const playlist = path.join(job.outDir, 'playlist.m3u8');
  const segmentPattern = path.join(job.outDir, 'seg_%05d.ts');

  // H.264 + AAC stereo downmix — browsers rarely support DTS/AC3 bitstream.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    job.inputPath,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    segmentPattern,
    playlist,
  ];

  job.status = 'starting';
  job.proc = spawn(config.FFMPEG_PATH, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  activeCount++;

  let stderrBuf = '';
  job.proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
    markReadyIfPlaylist(job);
  });

  const readyPoll = setInterval(() => {
    markReadyIfPlaylist(job);
    if (job.ready) {
      job.status = 'ready';
    }
  }, 500);

  job.proc.on('error', (err) => {
    clearInterval(readyPoll);
    job.status = 'error';
    job.error = err.message;
    job.proc = null;
    activeCount = Math.max(0, activeCount - 1);
    pumpQueue();
  });

  job.proc.on('close', (code) => {
    clearInterval(readyPoll);
    job.proc = null;
    activeCount = Math.max(0, activeCount - 1);
    markReadyIfPlaylist(job);
    if (code === 0 || job.ready) {
      job.status = 'done';
      job.ready = true;
    } else {
      job.status = 'error';
      job.error = stderrBuf.trim() || `ffmpeg exited with code ${code}`;
    }
    pumpQueue();
  });

  job.status = 'running';
}

function pumpQueue(): void {
  while (activeCount < config.TRANSCODE_MAX_JOBS && waitQueue.length) {
    const id = waitQueue.shift()!;
    const job = jobs.get(id);
    if (!job || job.proc) continue;
    if (job.status === 'done' || job.status === 'ready') continue;
    startFfmpeg(job);
  }
}

/** Ensure a transcode job is running / queued for this media. */
export function ensureTranscode(mediaId: number, inputPath: string): {
  status: TranscodeJobStatus;
  ready: boolean;
  error?: string;
} {
  if (!config.TRANSCODE_ENABLED) {
    return { status: 'idle', ready: false, error: 'Transcodage désactivé (TRANSCODE_ENABLED=false)' };
  }

  let job = jobs.get(mediaId);
  if (!job) {
    job = {
      mediaId,
      inputPath,
      outDir: outDirFor(mediaId),
      status: 'queued',
      proc: null,
      startedAt: Date.now(),
      lastAccess: Date.now(),
      ready: false,
    };
    jobs.set(mediaId, job);
  } else {
    job.lastAccess = Date.now();
    job.inputPath = inputPath;
  }

  if (fs.existsSync(playlistPath(mediaId)) && (job.status === 'done' || job.status === 'ready')) {
    job.ready = true;
    return { status: job.status, ready: true };
  }

  if (job.proc) {
    markReadyIfPlaylist(job);
    return { status: job.status, ready: job.ready, error: job.error };
  }

  if (job.status === 'error') {
    // Retry
    job.status = 'queued';
    job.error = undefined;
    job.ready = false;
  }

  if (activeCount < config.TRANSCODE_MAX_JOBS) {
    startFfmpeg(job);
  } else if (!waitQueue.includes(mediaId)) {
    job.status = 'queued';
    waitQueue.push(mediaId);
  }

  return { status: job.status, ready: job.ready, error: job.error };
}

export function getPlaylistFile(mediaId: number): string | null {
  const p = playlistPath(mediaId);
  return fs.existsSync(p) ? p : null;
}

export function getSegmentFile(mediaId: number, name: string): string | null {
  // Prevent path traversal
  if (!/^(playlist\.m3u8|seg_\d+\.ts|init\.mp4)$/.test(name)) return null;
  const p = path.join(outDirFor(mediaId), name);
  const resolved = path.resolve(p);
  const root = path.resolve(outDirFor(mediaId));
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/** Rewrite playlist paths to absolute API URLs if needed — segments are relative, served from same dir. */
export function readPlaylist(mediaId: number): string | null {
  const p = getPlaylistFile(mediaId);
  if (!p) return null;
  const job = jobs.get(mediaId);
  if (job) job.lastAccess = Date.now();
  return fs.readFileSync(p, 'utf8');
}

export function touchJob(mediaId: number): void {
  const job = jobs.get(mediaId);
  if (job) job.lastAccess = Date.now();
}

/** Remove stale cache dirs older than TTL. */
export function cleanTranscodeCache(): number {
  const root = config.TRANSCODE_CACHE_PATH;
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const name of fs.readdirSync(root)) {
    const id = Number(name);
    const dir = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const job = Number.isFinite(id) ? jobs.get(id) : undefined;
    const last = job?.lastAccess ?? st.mtimeMs;
    if (job?.proc) continue; // don't wipe active
    if (now - last < config.TRANSCODE_CACHE_TTL_MS) continue;

    try {
      if (job?.proc) {
        try {
          job.proc.kill('SIGTERM');
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (Number.isFinite(id)) jobs.delete(id);
      removed++;
    } catch {}
  }
  return removed;
}

export function startCacheCleaner(): void {
  const tick = () => {
    try {
      cleanTranscodeCache();
    } catch (e) {
      console.error('transcode cache clean failed', e);
    }
  };
  tick();
  setInterval(tick, 15 * 60 * 1000).unref?.();
}

/** Test helpers */
export function _resetTranscodeForTests(): void {
  for (const job of jobs.values()) {
    if (job.proc) {
      try {
        job.proc.kill('SIGKILL');
      } catch {}
    }
  }
  jobs.clear();
  waitQueue.length = 0;
  activeCount = 0;
}
