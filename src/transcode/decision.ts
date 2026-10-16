import { config } from '../config';
import { extOf } from './formats';
import type { MediaProbe } from '../media/probe';

/**
 * Plex-like playback decision engine.
 *
 * Three modes, like Plex:
 * - Direct Play   : original file served as-is (browser can decode everything)
 * - Direct Stream : container remuxed on the fly, video and/or audio copied
 *                   without re-encoding (very cheap on a NAS CPU)
 * - Transcode     : full re-encode to H.264 + AAC (stereo or 5.1 surround)
 *
 * Audio policy (the DTS / 5.1 support):
 * - Browsers cannot decode DTS / TrueHD / FLAC-multichannel bitstreams, so
 *   those are transcoded — but to multichannel AAC 5.1 (384k) instead of
 *   forced stereo, preserving the surround experience.
 * - AC-3 / E-AC-3 can optionally be passed through for Safari/Apple clients.
 */

export type PlayMode = 'direct' | 'direct-stream' | 'transcode';
export type VideoAction = 'direct' | 'copy' | 'transcode';
export type AudioAction = 'direct' | 'copy' | 'transcode' | 'passthrough' | 'none';

export type Quality = 'original' | '1080p' | '720p' | '480p';
export const QUALITIES: Quality[] = ['original', '1080p', '720p', '480p'];

export interface SessionProfile {
  quality: Quality;
  /** 0-based audio track index (0:a:N). */
  audioIndex: number;
  /** Request the surround (multichannel) rendition instead of stereo. */
  surround: boolean;
  /** Bitstream passthrough of AC-3/E-AC-3 (Safari/Apple only). */
  passthrough: boolean;
}

export const DEFAULT_PROFILE: SessionProfile = {
  quality: 'original',
  audioIndex: 0,
  surround: false,
  passthrough: false,
};

export function parseProfileFromQuery(q: Record<string, unknown>): SessionProfile {
  const qualityRaw = String(q.quality || 'original').toLowerCase();
  const quality: Quality = (QUALITIES as string[]).includes(qualityRaw)
    ? (qualityRaw as Quality)
    : 'original';
  const ai = parseInt(String(q.audio ?? q.audioIndex ?? '0'), 10);
  const truthy = (v: unknown) => v === '1' || v === 'true' || v === 'yes';
  return {
    quality,
    audioIndex: Number.isFinite(ai) && ai >= 0 ? Math.min(ai, 15) : 0,
    surround: truthy(q.surround),
    passthrough: truthy(q.passthrough),
  };
}

/** Stable key for the transcode session cache directory. */
export function profileKey(p: SessionProfile): string {
  if (
    p.quality === 'original' &&
    p.audioIndex === 0 &&
    !p.surround &&
    !p.passthrough
  ) {
    return 'default';
  }
  return `q${p.quality}-a${p.audioIndex}-${p.surround ? 's51' : 'st'}${p.passthrough ? '-pt' : ''}`;
}

export function profileLabel(p: SessionProfile): string {
  const q = p.quality === 'original' ? 'Original' : p.quality;
  const a = p.passthrough ? 'Original (passthrough)' : p.surround ? 'Surround 5.1' : 'Stéréo';
  return `${q} · ${a}`;
}

export interface PlaybackDecision {
  /** Overall mode for the HLS session (Direct Play is only for raw file serving). */
  mode: PlayMode;
  video: VideoAction;
  audio: AudioAction;
  audioCodec: string; // target codec label: "AAC", "AC-3"…
  audioChannels: number; // target channel count
  audioSourceIndex: number; // resolved 0:a:N index
  reason: string;
  warnings: string[];
  /** True when the source has multichannel audio worth preserving. */
  sourceHasSurround: boolean;
}

const BROWSER_NATIVE_AUDIO = new Set(['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'flac', 'wav', 'alac']);
const HLS_TS_COPYABLE_AUDIO = new Set(['aac', 'mp3', 'mp2', 'ac3', 'eac3']);
const PASSTHROUGH_CODECS = new Set(['ac3', 'eac3']);

function extContainerKind(ext: string): 'mp4' | 'webm' | 'mkv' | 'other' {
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') return 'mp4';
  if (ext === '.webm') return 'webm';
  if (ext === '.mkv') return 'mkv';
  return 'other';
}

/**
 * Decide how to serve an HLS Compatible session.
 * Pure function (reads config for copy-codec policy) — unit tested.
 */
export function decideHls(
  probe: MediaProbe | null,
  filenameOrPath: string,
  profile: SessionProfile
): PlaybackDecision {
  const warnings: string[] = [];
  const ext = extOf(filenameOrPath);

  // No probe (ffprobe missing/failed) → historical safe behavior: full transcode.
  if (!probe) {
    return {
      mode: 'transcode',
      video: 'transcode',
      audio: 'transcode',
      audioCodec: 'AAC',
      audioChannels: 2,
      audioSourceIndex: 0,
      reason: `${ext || 'conteneur'} — codecs inconnus (analyse indisponible), transcodage complet H.264 + AAC.`,
      warnings,
      sourceHasSurround: false,
    };
  }

  const v0 = probe.video[0];
  const audioTracks = probe.audio;
  const srcIdx =
    profile.audioIndex >= 0 && profile.audioIndex < audioTracks.length ? profile.audioIndex : 0;
  if (profile.audioIndex >= audioTracks.length && audioTracks.length > 0) {
    warnings.push(`Piste audio ${profile.audioIndex} inexistante — utilisation de la piste 0.`);
  }
  const a0 = audioTracks[srcIdx];
  const sourceHasSurround = audioTracks.some((a) => a.channels >= 6);

  // ---- Video ----
  let video: VideoAction = 'transcode';
  let videoReason = '';
  const copyCodecs = config.TRANSCODE_COPY_CODECS;
  if (!v0) {
    video = 'transcode';
    videoReason = 'pas de piste vidéo détectée';
  } else if (profile.quality !== 'original') {
    video = 'transcode';
    videoReason = `mise à l'échelle ${profile.quality}`;
  } else if (config.TRANSCODE_VIDEO_COPY && copyCodecs.includes(v0.codec.toLowerCase())) {
    video = 'copy';
    videoReason = `${v0.codec.toUpperCase()} copié sans ré-encodage (Direct Stream)`;
  } else {
    video = 'transcode';
    videoReason = v0
      ? `${v0.codec.toUpperCase()} → H.264`
      : 'vidéo → H.264';
  }

  // ---- Audio ----
  let audio: AudioAction = 'transcode';
  let audioCodec = 'AAC';
  let audioChannels = 2;
  let audioReason = '';

  if (!a0) {
    audio = 'none';
    audioReason = 'aucune piste audio';
  } else {
    const srcCodec = a0.codec.toLowerCase();
    const srcCh = a0.channels || 2;

    if (profile.passthrough) {
      if (!config.TRANSCODE_AUDIO_PASSTHROUGH) {
        warnings.push('Passthrough désactivé sur le serveur — transcodage AAC à la place.');
      } else if (!PASSTHROUGH_CODECS.has(srcCodec)) {
        warnings.push(
          `Passthrough impossible (${srcCodec.toUpperCase()}), seul AC-3/E-AC-3 est supporté — transcodage AAC.`
        );
      } else {
        audio = 'passthrough';
        audioCodec = srcCodec === 'eac3' ? 'E-AC-3' : 'AC-3';
        audioChannels = srcCh;
        audioReason = `${audioCodec} ${srcCh >= 6 ? '5.1' : 'stéréo'} original conservé (Safari/TV uniquement)`;
      }
    }

    if (audio === 'transcode' && !audioReason) {
      if (profile.surround) {
        const targetCh = srcCh >= 6 ? Math.min(srcCh, 6) : 2;
        const surroundCodec = config.TRANSCODE_SURROUND_CODEC;
        if (srcCh < 6) {
          warnings.push('Source stéréo — le mode Surround conserve 2 canaux (pas de upmix artificiel).');
        }
        if (
          targetCh === srcCh &&
          ((surroundCodec === 'aac' && srcCodec === 'aac') ||
            (surroundCodec === srcCodec && HLS_TS_COPYABLE_AUDIO.has(srcCodec)))
        ) {
          audio = 'copy';
          audioCodec = 'AAC';
          audioChannels = srcCh;
          audioReason = 'audio multicanal AAC copié sans ré-encodage';
        } else {
          audio = 'transcode';
          audioCodec = surroundCodec === 'eac3' ? 'E-AC-3' : surroundCodec === 'ac3' ? 'AC-3' : 'AAC';
          audioChannels = targetCh;
          audioReason = `${srcCodec.toUpperCase()} ${srcCh >= 6 ? channelShort(srcCh) : 'stéréo'} → ${audioCodec} ${targetCh >= 6 ? channelShort(targetCh) : 'stéréo'} (surround préservé)`;
        }
      } else {
        // Stereo rendition
        if (
          (srcCodec === 'aac' || srcCodec === 'mp3') &&
          srcCh <= 2 &&
          HLS_TS_COPYABLE_AUDIO.has(srcCodec)
        ) {
          audio = 'copy';
          audioCodec = srcCodec.toUpperCase();
          audioChannels = srcCh;
          audioReason = `audio ${audioCodec} stéréo copié`;
        } else {
          audio = 'transcode';
          audioCodec = 'AAC';
          audioChannels = 2;
          audioReason =
            srcCh >= 6 || !BROWSER_NATIVE_AUDIO.has(srcCodec)
              ? `${srcCodec.toUpperCase()} ${channelShort(srcCh)} → AAC stéréo (downmix)`
              : `${srcCodec.toUpperCase()} → AAC stéréo`;
        }
      }
    }
  }

  // ---- Overall mode ----
  let mode: PlayMode = 'transcode';
  if (video === 'copy' && (audio === 'copy' || audio === 'passthrough' || audio === 'none')) {
    mode = 'direct-stream';
  } else if (video === 'transcode' || audio === 'transcode') {
    mode = 'transcode';
  }

  const reason =
    mode === 'direct-stream'
      ? `Remux direct — ${videoReason}, ${audioReason}.`
      : `Transcodage — ${videoReason}, ${audioReason}.`;

  void extContainerKind(ext);
  return {
    mode,
    video,
    audio,
    audioCodec,
    audioChannels,
    audioSourceIndex: srcIdx,
    reason,
    warnings,
    sourceHasSurround,
  };
}

function channelShort(ch: number): string {
  if (ch === 6) return '5.1';
  if (ch === 8) return '7.1';
  if (ch === 2) return 'stéréo';
  if (ch === 1) return 'mono';
  return `${ch}ch`;
}

/** Human mode label for UI / dashboard. */
export function modeLabel(mode: PlayMode): string {
  switch (mode) {
    case 'direct':
      return 'Lecture directe';
    case 'direct-stream':
      return 'Remux direct';
    case 'transcode':
      return 'Transcodage';
  }
}
