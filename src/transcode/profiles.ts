import { spawnSync } from 'child_process';
import fs from 'fs';
import { config } from '../config';
import type { MediaProbe } from '../media/probe';
import {
  decideHls,
  type PlaybackDecision,
  type Quality,
  type SessionProfile,
} from './decision';

/**
 * ffmpeg argument builder for HLS Compatible sessions.
 *
 * Profiles (Plex-like):
 * - quality: original (remux when possible) / 1080p / 720p / 480p
 * - audio:   stereo AAC downmix (default) or surround AAC 5.1 (DTS/TrueHD/AC3
 *            preserved as multichannel instead of forced stereo)
 * - video:   stream-copy (Direct Stream) when the source is HLS-friendly
 */

export interface QualityPreset {
  maxHeight: number;
  maxrate: string;
  bufsize: string;
  crf: number;
}

export const QUALITY_PRESETS: Record<Exclude<Quality, 'original'>, QualityPreset> = {
  '1080p': { maxHeight: 1080, maxrate: '8M', bufsize: '16M', crf: 23 },
  '720p': { maxHeight: 720, maxrate: '5M', bufsize: '10M', crf: 23 },
  '480p': { maxHeight: 480, maxrate: '2M', bufsize: '4M', crf: 24 },
};

export interface TranscodePlan {
  decision: PlaybackDecision;
  videoEncoder: string; // libx264 | h264_qsv | h264_vaapi | copy
  hwaccel: string; // none | qsv | vaapi
}

// ---------------------------------------------------------------------------
// Hardware acceleration detection (cached)
// ---------------------------------------------------------------------------

let cachedEncoders: Set<string> | null = null;
let cachedDri = false;
let cachedDriChecked = false;

export function availableEncoders(): Set<string> {
  if (cachedEncoders) return cachedEncoders;
  const set = new Set<string>();
  try {
    const r = spawnSync(config.FFMPEG_PATH, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const out = String(r.stdout || '');
    for (const line of out.split('\n')) {
      const m = /^\s*\S+\s+(\S+)\s+/.exec(line);
      if (m) set.add(m[1]);
    }
  } catch {
    /* ffmpeg missing — software fallback */
  }
  cachedEncoders = set;
  return set;
}

function hasDri(): boolean {
  if (cachedDriChecked) return cachedDri;
  cachedDriChecked = true;
  try {
    cachedDri = fs.existsSync('/dev/dri');
  } catch {
    cachedDri = false;
  }
  return cachedDri;
}

function pickHwaccel(): { encoder: string; hw: string } {
  const want = (config.TRANSCODE_HWACCEL || 'none').toLowerCase();
  if (want === 'none') return { encoder: 'libx264', hw: 'none' };
  const enc = availableEncoders();
  const tryQsv = want === 'qsv' || want === 'auto' || want === 'quicksync';
  const tryVaapi = want === 'vaapi' || want === 'auto';
  if (tryQsv && enc.has('h264_qsv')) return { encoder: 'h264_qsv', hw: 'qsv' };
  if (tryVaapi && enc.has('h264_vaapi') && hasDri()) return { encoder: 'h264_vaapi', hw: 'vaapi' };
  return { encoder: 'libx264', hw: 'none' };
}

// ---------------------------------------------------------------------------
// Argument builder (pure given explicit hw choice — unit tested)
// ---------------------------------------------------------------------------

export interface BuildArgsInput {
  inputPath: string;
  probe: MediaProbe | null;
  filenameOrPath: string;
  profile: SessionProfile;
  playlistPath: string;
  segmentPattern: string;
  /** Override hardware selection (tests / explicit). Defaults to config-based pick. */
  forceHw?: { encoder: string; hw: string };
}

export function buildPlan(
  probe: MediaProbe | null,
  filenameOrPath: string,
  profile: SessionProfile,
  forceHw?: { encoder: string; hw: string }
): TranscodePlan {
  const decision = decideHls(probe, filenameOrPath, profile);
  const hw = forceHw || pickHwaccel();
  const videoEncoder = decision.video === 'copy' ? 'copy' : hw.encoder;
  return { decision, videoEncoder, hwaccel: decision.video === 'copy' ? 'none' : hw.hw };
}

export function buildFfmpegArgs(input: BuildArgsInput): { args: string[]; plan: TranscodePlan } {
  const { inputPath, probe, filenameOrPath, profile, playlistPath, segmentPattern } = input;
  const plan = buildPlan(probe, filenameOrPath, profile, input.forceHw);
  const d = plan.decision;

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];

  // VAAPI needs the device upfront
  if (plan.hwaccel === 'vaapi') {
    args.push('-vaapi_device', config.TRANSCODE_VAAPI_DEVICE);
  }

  args.push('-i', inputPath);

  // ---- Maps ----
  args.push('-map', '0:v:0?');
  if (d.audio === 'none') {
    args.push('-map', '-0:a?');
  } else {
    args.push('-map', `0:a:${d.audioSourceIndex}?`);
  }

  // ---- Video ----
  if (d.video === 'copy') {
    args.push('-c:v', 'copy');
  } else if (plan.videoEncoder === 'h264_vaapi') {
    const vf = vaapiScaleFilter(profile.quality);
    args.push('-vf', vf, '-c:v', 'h264_vaapi', '-profile:v', 'main');
    const preset = QUALITY_PRESETS[profile.quality as Exclude<Quality, 'original'>];
    if (preset) {
      args.push('-b:v', preset.maxrate, '-maxrate', preset.maxrate, '-bufsize', preset.bufsize);
    } else {
      args.push('-b:v', '8M', '-maxrate', '10M', '-bufsize', '20M');
    }
  } else if (plan.videoEncoder === 'h264_qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', 'veryfast');
    const preset = QUALITY_PRESETS[profile.quality as Exclude<Quality, 'original'>];
    if (profile.quality !== 'original') {
      args.push(
        '-vf',
        scaleFilter(QUALITY_PRESETS[profile.quality as Exclude<Quality, 'original'>].maxHeight)
      );
    }
    if (preset) {
      args.push('-b:v', preset.maxrate, '-maxrate', preset.maxrate, '-bufsize', preset.bufsize);
    }
    args.push('-pix_fmt', 'nv12');
  } else {
    // libx264 software path (default — historical flags preserved)
    args.push('-c:v', 'libx264', '-preset', config.TRANSCODE_PRESET);
    const preset = QUALITY_PRESETS[profile.quality as Exclude<Quality, 'original'>];
    if (profile.quality === 'original') {
      args.push('-crf', String(config.TRANSCODE_CRF));
    } else if (preset) {
      args.push(
        '-vf',
        scaleFilter(preset.maxHeight),
        '-crf',
        String(preset.crf),
        '-maxrate',
        preset.maxrate,
        '-bufsize',
        preset.bufsize
      );
    }
    args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p');
  }

  // ---- Audio ----
  if (d.audio === 'none') {
    args.push('-an');
  } else if (d.audio === 'copy' || d.audio === 'passthrough') {
    args.push('-c:a', 'copy');
  } else {
    const enc = audioEncoderFor(d.audioCodec);
    args.push('-c:a', enc, '-ac', String(d.audioChannels));
    args.push('-b:a', d.audioChannels >= 6 ? config.TRANSCODE_SURROUND_BITRATE : config.TRANSCODE_STEREO_BITRATE);
    if (d.audioChannels >= 6) {
      // Keep a standard 5.1 layout so browsers/TVs map channels correctly
      args.push('-channel_layout', d.audioChannels === 8 ? '7.1' : '5.1');
    }
  }

  // ---- HLS mux ----
  args.push(
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
    playlistPath
  );

  return { args, plan };
}

function scaleFilter(maxHeight: number): string {
  return `scale=-2:min'(${maxHeight}\\,ih)'`;
}

function vaapiScaleFilter(quality: Quality): string {
  const base = 'format=nv12,hwupload';
  if (quality === 'original') return base;
  const preset = QUALITY_PRESETS[quality as Exclude<Quality, 'original'>];
  return `${base},scale_vaapi=-2:${preset.maxHeight}`;
}

function audioEncoderFor(codecLabel: string): string {
  const c = codecLabel.toUpperCase();
  if (c === 'E-AC-3') return 'eac3';
  if (c === 'AC-3') return 'ac3';
  return 'aac';
}

/** Test helpers */
export function _resetHwCacheForTests(): void {
  cachedEncoders = null;
  cachedDri = false;
  cachedDriChecked = false;
}
