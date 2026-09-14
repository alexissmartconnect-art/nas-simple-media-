import path from 'path';

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
 */
export function getPlaybackHint(filenameOrPath: string, mediaType: string): PlaybackHint {
  const ext = extOf(filenameOrPath);
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
      reason: `${ext} — conteneur souvent incompatible navigateur (DTS/AC3/HEVC). Mode Compatible = H.264+AAC stéréo.`,
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
