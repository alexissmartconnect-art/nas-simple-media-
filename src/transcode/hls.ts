import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { config } from '../config';
import { getDb } from '../db/schema';
import type { MediaProbe } from '../media/probe';
import {
  DEFAULT_PROFILE,
  profileKey,
  profileLabel,
  type SessionProfile,
} from './decision';
import { buildFfmpegArgs } from './profiles';

export type TranscodeJobStatus = 'queued' | 'starting' | 'running' | 'ready' | 'done' | 'error' | 'idle';

export type Job = {
  key: string;
  mediaId: number;
  profileKey: string;
  profile: SessionProfile;
  inputPath: string;
  outDir: string;
  status: TranscodeJobStatus;
  error?: string;
  /** Plex-style plan description ("Remux direct — …", "Transcodage — …"). */
  plan?: string;
  mode?: string;
  proc: ChildProcess | null;
  startedAt: number;
  lastAccess: number;
  ready: boolean;
};

const jobs = new Map<string, Job>();
let activeCount = 0;
const waitQueue: string[] = [];

function jobKey(mediaId: number, pKey: string): string {
  return `${mediaId}:${pKey}`;
}

function outDirFor(mediaId: number, pKey = 'default'): string {
  if (pKey === 'default') return path.join(config.TRANSCODE_CACHE_PATH, String(mediaId));
  return path.join(config.TRANSCODE_CACHE_PATH, `${mediaId}-${pKey}`);
}

function playlistPath(mediaId: number, pKey = 'default'): string {
  return path.join(outDirFor(mediaId, pKey), 'playlist.m3u8');
}

export function isPlaylistPlayable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes('#EXTM3U') && content.includes('#EXTINF:');
  } catch {
    return false;
  }
}

export function isTranscodeEnabled(): boolean {
  return config.TRANSCODE_ENABLED;
}

function statusOf(mediaId: number, pKey: string) {
  if (!config.TRANSCODE_ENABLED) {
    return { status: 'idle' as TranscodeJobStatus, ready: false, enabled: false, error: 'Transcodage désactivé' };
  }
  const pl = playlistPath(mediaId, pKey);
  const job = jobs.get(jobKey(mediaId, pKey));
  if (!job) {
    if (isPlaylistPlayable(pl)) {
      return { status: 'ready' as TranscodeJobStatus, ready: true, enabled: true };
    }
    return { status: 'idle' as TranscodeJobStatus, ready: false, enabled: true };
  }
  job.lastAccess = Date.now();
  const ready = job.ready || isPlaylistPlayable(pl);
  if (ready) job.ready = true;
  return {
    status: job.status,
    ready,
    error: job.error,
    enabled: true,
    plan: job.plan,
    mode: job.mode,
  };
}

export function getJobStatus(
  mediaId: number,
  profile?: SessionProfile
): {
  status: TranscodeJobStatus;
  ready: boolean;
  error?: string;
  enabled: boolean;
  plan?: string;
  mode?: string;
} {
  return statusOf(mediaId, profileKey(profile || DEFAULT_PROFILE));
}

function markReadyIfPlaylist(job: Job): void {
  if (isPlaylistPlayable(path.join(job.outDir, 'playlist.m3u8'))) {
    job.ready = true;
    if (job.status === 'starting' || job.status === 'running') {
      job.status = 'ready';
    }
  }
}

function startFfmpeg(job: Job, probe: MediaProbe | null, filenameOrPath: string): void {
  fs.mkdirSync(job.outDir, { recursive: true });
  // Clean previous incomplete run
  for (const f of fs.readdirSync(job.outDir)) {
    try {
      fs.unlinkSync(path.join(job.outDir, f));
    } catch {}
  }

  const playlist = path.join(job.outDir, 'playlist.m3u8');
  const segmentPattern = path.join(job.outDir, 'seg_%05d.ts');

  const { args, plan } = buildFfmpegArgs({
    inputPath: job.inputPath,
    probe,
    filenameOrPath,
    profile: job.profile,
    playlistPath: playlist,
    segmentPattern,
  });
  job.plan = plan.decision.reason;
  job.mode = plan.decision.mode;

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
  readyPoll.unref?.();

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

// Queued jobs need their probe/plan at start time — stash it on the job record.
const pendingCtx = new Map<string, { probe: MediaProbe | null; filenameOrPath: string }>();

function pumpQueue(): void {
  while (activeCount < config.TRANSCODE_MAX_JOBS && waitQueue.length) {
    const key = waitQueue.shift()!;
    const job = jobs.get(key);
    if (!job || job.proc) continue;
    if (job.status === 'done' || job.status === 'ready') continue;
    const ctx = pendingCtx.get(key) || { probe: null, filenameOrPath: job.inputPath };
    startFfmpeg(job, ctx.probe, ctx.filenameOrPath);
  }
}

export interface EnsureTranscodeOpts {
  profile?: SessionProfile;
  probe?: MediaProbe | null;
  filename?: string;
}

/** Ensure a transcode job is running / queued for this media + profile. */
export function ensureTranscode(
  mediaId: number,
  inputPath: string,
  opts?: EnsureTranscodeOpts
): {
  status: TranscodeJobStatus;
  ready: boolean;
  error?: string;
  plan?: string;
  mode?: string;
  profileKey?: string;
  profileLabel?: string;
} {
  if (!config.TRANSCODE_ENABLED) {
    return { status: 'idle', ready: false, error: 'Transcodage désactivé (TRANSCODE_ENABLED=false)' };
  }

  const profile: SessionProfile = opts?.profile || DEFAULT_PROFILE;
  const pKey = profileKey(profile);
  const key = jobKey(mediaId, pKey);

  let job = jobs.get(key);
  if (job && job.inputPath !== inputPath) {
    invalidateTranscodeCache(mediaId, profile);
    job = undefined;
  }

  if (!job) {
    job = {
      key,
      mediaId,
      profileKey: pKey,
      profile,
      inputPath,
      outDir: outDirFor(mediaId, pKey),
      status: 'queued',
      proc: null,
      startedAt: Date.now(),
      lastAccess: Date.now(),
      ready: false,
    };
    jobs.set(key, job);
  } else {
    job.lastAccess = Date.now();
  }
  pendingCtx.set(key, {
    probe: opts?.probe ?? null,
    filenameOrPath: opts?.filename || inputPath,
  });

  if (isPlaylistPlayable(playlistPath(mediaId, pKey)) && (job.status === 'done' || job.status === 'ready')) {
    job.ready = true;
    return {
      status: job.status,
      ready: true,
      plan: job.plan,
      mode: job.mode,
      profileKey: pKey,
      profileLabel: profileLabel(profile),
    };
  }

  if (job.proc) {
    markReadyIfPlaylist(job);
    return {
      status: job.status,
      ready: job.ready,
      error: job.error,
      plan: job.plan,
      mode: job.mode,
      profileKey: pKey,
      profileLabel: profileLabel(profile),
    };
  }

  if (job.status === 'error') {
    // Retry
    job.status = 'queued';
    job.error = undefined;
    job.ready = false;
  }

  if (activeCount < config.TRANSCODE_MAX_JOBS) {
    const ctx = pendingCtx.get(key)!;
    startFfmpeg(job, ctx.probe, ctx.filenameOrPath);
  } else if (!waitQueue.includes(key)) {
    job.status = 'queued';
    waitQueue.push(key);
  }

  return {
    status: job.status,
    ready: job.ready,
    error: job.error,
    plan: job.plan,
    mode: job.mode,
    profileKey: pKey,
    profileLabel: profileLabel(profile),
  };
}

export function getPlaylistFile(mediaId: number, profile?: SessionProfile): string | null {
  const p = playlistPath(mediaId, profileKey(profile || DEFAULT_PROFILE));
  return isPlaylistPlayable(p) ? p : null;
}

export function getSegmentFile(
  mediaId: number,
  name: string,
  profile?: SessionProfile
): string | null {
  // Prevent path traversal
  if (!/^(playlist\.m3u8|seg_\d+\.ts|init\.mp4)$/.test(name)) return null;
  const outDir = outDirFor(mediaId, profileKey(profile || DEFAULT_PROFILE));
  const p = path.join(outDir, name);
  const resolved = path.resolve(p);
  const root = path.resolve(outDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/** Append query string (e.g. `token=...` or `password=...`) to segment lines in an HLS playlist. */
export function formatPlaylistWithQuery(body: string, queryParam?: string): string {
  if (!queryParam) return body;
  const cleanQuery = queryParam.replace(/^[?&]/, '');
  if (!cleanQuery) return body;
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const sep = t.includes('?') ? '&' : '?';
      return `${t}${sep}${cleanQuery}`;
    })
    .join('\n');
}

/** Read playlist content once at least one segment is playable. */
export function readPlaylist(
  mediaId: number,
  queryParam?: string,
  profile?: SessionProfile
): string | null {
  const p = getPlaylistFile(mediaId, profile);
  if (!p) return null;
  const job = jobs.get(jobKey(mediaId, profileKey(profile || DEFAULT_PROFILE)));
  if (job) job.lastAccess = Date.now();
  const raw = fs.readFileSync(p, 'utf8');
  return formatPlaylistWithQuery(raw, queryParam);
}

export function touchJob(mediaId: number, profile?: SessionProfile): void {
  const job = jobs.get(jobKey(mediaId, profileKey(profile || DEFAULT_PROFILE)));
  if (job) job.lastAccess = Date.now();
}

/**
 * Invalidate cache for one media. Without a profile, wipes ALL profiles
 * (default dir + `<id>-<profile>` dirs).
 */
export function invalidateTranscodeCache(mediaId: number, profile?: SessionProfile): void {
  if (profile) {
    const pKey = profileKey(profile);
    const key = jobKey(mediaId, pKey);
    const job = jobs.get(key);
    if (job?.proc) {
      try {
        job.proc.kill('SIGTERM');
      } catch {}
    }
    jobs.delete(key);
    pendingCtx.delete(key);
    const idx = waitQueue.indexOf(key);
    if (idx !== -1) waitQueue.splice(idx, 1);
    try {
      fs.rmSync(outDirFor(mediaId, pKey), { recursive: true, force: true });
    } catch {}
    return;
  }
  // All profiles
  for (const [key, job] of [...jobs.entries()]) {
    if (job.mediaId !== mediaId) continue;
    if (job.proc) {
      try {
        job.proc.kill('SIGTERM');
      } catch {}
    }
    jobs.delete(key);
    pendingCtx.delete(key);
    const idx = waitQueue.indexOf(key);
    if (idx !== -1) waitQueue.splice(idx, 1);
  }
  try {
    fs.rmSync(outDirFor(mediaId, 'default'), { recursive: true, force: true });
  } catch {}
  try {
    const root = config.TRANSCODE_CACHE_PATH;
    if (fs.existsSync(root)) {
      const prefix = `${mediaId}-`;
      for (const name of fs.readdirSync(root)) {
        if (name.startsWith(prefix)) {
          try {
            fs.rmSync(path.join(root, name), { recursive: true, force: true });
          } catch {}
        }
      }
    }
  } catch {}
}

/** Remove stale cache dirs older than TTL. */
export function cleanTranscodeCache(): number {
  const root = config.TRANSCODE_CACHE_PATH;
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  const now = Date.now();
  // Map dir name -> job for lastAccess
  const dirToJob = new Map<string, Job>();
  for (const job of jobs.values()) {
    dirToJob.set(path.basename(job.outDir), job);
  }
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const job = dirToJob.get(name);
    const last = job?.lastAccess ?? st.mtimeMs;
    if (job?.proc) continue; // don't wipe active
    if (now - last < config.TRANSCODE_CACHE_TTL_MS) continue;

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (job) {
        jobs.delete(job.key);
        pendingCtx.delete(job.key);
      }
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

export function stopAllTranscodeJobs(): void {
  for (const job of jobs.values()) {
    if (job.proc) {
      try {
        job.proc.kill('SIGTERM');
      } catch {}
    }
  }
  jobs.clear();
  pendingCtx.clear();
  waitQueue.length = 0;
  activeCount = 0;
}

// ---------------------------------------------------------------------------
// Admin dashboard (Plex-like "Now playing / transcodes")
// ---------------------------------------------------------------------------

export interface TranscodeSessionInfo {
  key: string;
  mediaId: number;
  title: string | null;
  profileKey: string;
  profileLabel: string;
  status: TranscodeJobStatus;
  ready: boolean;
  mode?: string;
  plan?: string;
  error?: string;
  startedAt: number;
  lastAccess: number;
  running: boolean;
}

export function listTranscodeJobs(): TranscodeSessionInfo[] {
  let titles = new Map<number, string>();
  try {
    const rows = getDb().prepare('SELECT id, title FROM media_items').all() as {
      id: number;
      title: string;
    }[];
    for (const r of rows) titles.set(r.id, r.title);
  } catch {
    titles = new Map();
  }
  return [...jobs.values()]
    .sort((a, b) => b.lastAccess - a.lastAccess)
    .map((j) => ({
      key: j.key,
      mediaId: j.mediaId,
      title: titles.get(j.mediaId) ?? null,
      profileKey: j.profileKey,
      profileLabel: profileLabel(j.profile),
      status: j.status,
      ready: j.ready,
      mode: j.mode,
      plan: j.plan,
      error: j.error,
      startedAt: j.startedAt,
      lastAccess: j.lastAccess,
      running: !!j.proc,
    }));
}

export function activeTranscodeCount(): number {
  return activeCount;
}

export function killTranscodeJob(key: string): boolean {
  const job = jobs.get(key);
  if (!job) return false;
  if (job.proc) {
    try {
      job.proc.kill('SIGTERM');
    } catch {}
    job.proc = null;
    activeCount = Math.max(0, activeCount - 1);
  }
  jobs.delete(key);
  pendingCtx.delete(key);
  const idx = waitQueue.indexOf(key);
  if (idx !== -1) waitQueue.splice(idx, 1);
  try {
    fs.rmSync(job.outDir, { recursive: true, force: true });
  } catch {}
  pumpQueue();
  return true;
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
  pendingCtx.clear();
  waitQueue.length = 0;
  activeCount = 0;
}
