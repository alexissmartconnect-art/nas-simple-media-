import path from 'path';
import type { ProbeSummary } from '../media/probe';

/** Containers that browsers typically play natively (video + common audio). */
const DIRECT_FRIENDLY_VIDEO = new Set(['.mp4', '.m4v', '.webm']);
const DIRECT_FRIENDLY_AUDIO = new Set(['.mp3', '.m4a', '.opus', '.wav', '.ogg']);

/** Hard containers — browsers rarely handle well (esp. DTS/AC3 inside). */
const HARD_VIDEO = new Set(['.mkv', '.avi', '.ts', '.m2ts', '.mpg', '.mpeg']);

export type PlaybackHint = {
  suggestedMode: 'direct' | 'compatible';
  directLikely: boolean;
  reason: string;
};

export function extOf(filenameOrPath: string): string {
  return path.extname(filenameOrPath).toLowerCase();
}

export function isVideoExt(ext: string): boolean {
  return DIRECT_FRIENDLY_VIDEO.has(ext) || HARD_VIDEO.has(ext) || ext === '.mov';
}

export function isAudioExt(ext: string): boolean {
  return DIRECT_FRIENDLY_AUDIO.has(ext) || ext === '.flac' || ext === '.aac';
}

/**
 * Heuristic without probing codecs: MKV/AVI → Compatible; MP4/WebM → Direct.
 * Note: even MP4 with DTS/AC3 may fail in browsers — UI can fall back.
 *
 * When a probe summary is provided (ffprobe), the hint becomes exact:
 * real video/audio codecs drive the recommendation, and multichannel
 * (DTS/TrueHD/AC-3 5.1) sources point to Compatible **Surround** (AAC 5.1).
 */
export function getPlaybackHint(
  filenameOrPath: string,
  mediaType: string,
  probe?: ProbeSummary | null
): PlaybackHint {
  const ext = extOf(filenameOrPath);
  if (probe) {
    const probed = hintFromProbe(ext, mediaType, probe);
    if (probed) return probed;
  }
  if (mediaType === 'track' || isAudioExt(ext)) {
    if (ext === '.flac') {
      return {
        suggestedMode: 'direct',
        directLikely: true,
        reason: 'Audio FLAC — lecture directe (navigateur) ou VLC pour tous les codecs',
      };
    }
    return {
      suggestedMode: 'direct',
      directLikely: DIRECT_FRIENDLY_AUDIO.has(ext),
      reason: 'Piste audio — lecture directe',
    };
  }
  if (HARD_VIDEO.has(ext)) {
    return {
      suggestedMode: 'compatible',
      directLikely: false,
      reason: `${ext} — conteneur souvent incompatible navigateur (DTS/AC3/HEVC). Mode Compatible = HLS (H.264 + AAC Stéréo ou Surround 5.1).`,
    };
  }
  if (DIRECT_FRIENDLY_VIDEO.has(ext)) {
    return {
      suggestedMode: 'direct',
      directLikely: true,
      reason: `${ext} — lecture directe probable (si codecs H.264/AAC ou VP9/Opus)`,
    };
  }
  return {
    suggestedMode: 'compatible',
    directLikely: false,
    reason: `Extension ${ext || '?'} — mode Compatible recommandé`,
  };
}

export function needsCompatByDefault(filenameOrPath: string, mediaType: string): boolean {
  return getPlaybackHint(filenameOrPath, mediaType).suggestedMode === 'compatible';
}

function hintFromProbe(ext: string, mediaType: string, probe: ProbeSummary): PlaybackHint | null {
  if (mediaType === 'track' || !probe.hasVideo) {
    if (probe.hasSurround) {
      return {
        suggestedMode: 'direct',
        directLikely: true,
        reason: `Audio multicanal (${probe.audioLabels[0] || '5.1'}) — lecture directe, downmix géré par l'appareil. VLC pour le bitstream exact.`,
      };
    }
    return null; // fall through to the generic audio hint
  }

  const video = (probe.videoLabel || '').toUpperCase();
  const needsVideoTranscode =
    video.startsWith('HEVC') ||
    video.startsWith('AV1') ||
    video.startsWith('VP9') ||
    video.startsWith('MPEG-2') ||
    video.startsWith('VC-1');
  const audio0 = (probe.audioLabels[0] || '').toUpperCase();
  const lossyBitstreamAudio =
    audio0.includes('DTS') || audio0.includes('TRUEHD') || audio0.includes('AC-3') || audio0.includes('E-AC-3');
  const needsAudioTranscode =
    lossyBitstreamAudio || audio0.includes('FLAC') || audio0.includes('OPUS') || audio0.includes('VORBIS') || audio0.includes('PCM');

  if (!needsVideoTranscode && !needsAudioTranscode && DIRECT_FRIENDLY_VIDEO.has(ext)) {
    return {
      suggestedMode: 'direct',
      directLikely: true,
      reason: `${probe.videoLabel || ext} + ${probe.audioLabels[0] || 'audio'} — lecture directe.`,
    };
  }

  if (probe.hasSurround) {
    const src = probe.audioLabels[0] || '5.1';
    const how = needsVideoTranscode ? 'vidéo convertie' : 'vidéo remuxée sans ré-encodage (Direct Stream)';
    return {
      suggestedMode: 'compatible',
      directLikely: false,
      reason: `${src} détecté — Compatible Surround : ${how}, audio préservé en AAC 5.1. Original intact via VLC.`,
    };
  }

  if (needsVideoTranscode || needsAudioTranscode || !DIRECT_FRIENDLY_VIDEO.has(ext)) {
    const what = [needsVideoTranscode ? probe.videoLabel || 'vidéo' : null, needsAudioTranscode ? probe.audioLabels[0] || 'audio' : null]
      .filter(Boolean)
      .join(' + ');
    return {
      suggestedMode: 'compatible',
      directLikely: false,
      reason: `${what || ext} — incompatible navigateur, conversion Compatible (H.264 + AAC).`,
    };
  }
  return null;
}
