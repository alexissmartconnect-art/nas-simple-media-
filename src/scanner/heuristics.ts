import path from 'path';
import { randomBytes } from 'crypto';
import { AUDIO_EXTS, VIDEO_EXTS, type LibraryKind, type MediaType } from '../config';

export interface ParsedMedia {
  title: string;
  type: MediaType;
  library: LibraryKind;
  show_name: string | null;
  season: number | null;
  episode: number | null;
  artist: string | null;
  album: string | null;
  track_num: number | null;
}

const SERIES_RE =
  /^(?<show>.+?)[.\s_\-]+[Ss](?<season>\d{1,2})[Ee](?<episode>\d{1,3})(?:[.\s_\-]+(?<epTitle>.+))?$/i;

const SERIES_X_RE =
  /^(?<show>.+?)[.\s_\-]+(?<season>\d{1,2})[xX](?<episode>\d{1,3})(?:[.\s_\-]+(?<epTitle>.+))?$/;

const MUSIC_DASH_RE =
  /^(?<artist>.+?)\s+-\s+(?<album>.+?)\s+-\s+(?:(?<trackNum>\d+)\s*[-.]?\s*)?(?<title>.+)$/;

const TRACK_NUM_PREFIX = /^(?<num>\d{1,3})[\s.\-_]+(?<title>.+)$/;

function clean(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, () => ' ')
    .trim();
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

export function isVideo(filename: string): boolean {
  return VIDEO_EXTS.has(path.extname(filename).toLowerCase());
}

export function isAudio(filename: string): boolean {
  return AUDIO_EXTS.has(path.extname(filename).toLowerCase());
}

export function isMediaFile(filename: string): boolean {
  return isVideo(filename) || isAudio(filename);
}

/**
 * Classify a media file. Optional forcedType locks library kind (from library definition).
 */
export function parseMediaFile(relativePath: string, forcedType?: LibraryKind): ParsedMedia | null {
  const filename = path.basename(relativePath);
  if (!isMediaFile(filename)) return null;

  const parts = relativePath.split(/[/\\]/).filter(Boolean);
  const top = (parts[0] || '').toLowerCase();
  const base = stripExt(filename);
  const audio = isAudio(filename);

  if (forcedType === 'movies') return movieFrom(base, parts);
  if (forcedType === 'series') {
    return (
      seriesFrom(base, parts) ?? {
        title: clean(base),
        type: 'episode' as const,
        library: 'series' as const,
        show_name: parts.length >= 2 ? clean(parts[parts.length - 2]) : clean(base),
        season: 1,
        episode: 1,
        artist: null,
        album: null,
        track_num: null,
      }
    );
  }
  if (forcedType === 'music') return musicFrom(base, parts);

  if (top === 'movies' || top === 'films' || top === 'movie') return movieFrom(base, parts);
  if (top === 'series' || top === 'tv' || top === 'shows' || top === 'series-tv') {
    return (
      seriesFrom(base, parts) ?? {
        title: clean(base),
        type: 'episode' as const,
        library: 'series' as const,
        show_name: parts.length >= 2 ? clean(parts[1]) : clean(base),
        season: 1,
        episode: 1,
        artist: null,
        album: null,
        track_num: null,
      }
    );
  }
  if (top === 'music' || top === 'musique' || top === 'audio') return musicFrom(base, parts);

  if (audio) return musicFrom(base, parts);
  const series = seriesFrom(base, parts);
  if (series) return series;
  return movieFrom(base, parts);
}

function seriesFrom(base: string, parts: string[]): ParsedMedia | null {
  const m = base.match(SERIES_RE) || base.match(SERIES_X_RE);
  if (m?.groups) {
    const show =
      clean(m.groups.show) ||
      (parts.length >= 2 ? clean(parts[parts.length - 2]) : clean(base));
    const epTitle = m.groups.epTitle ? clean(m.groups.epTitle) : null;
    return {
      title:
        epTitle ||
        `S${String(m.groups.season).padStart(2, '0')}E${String(m.groups.episode).padStart(2, '0')}`,
      type: 'episode',
      library: 'series',
      show_name: show,
      season: parseInt(m.groups.season, 10),
      episode: parseInt(m.groups.episode, 10),
      artist: null,
      album: null,
      track_num: null,
    };
  }

  const seasonFolder = parts.find((p) => /^[Ss]eason[.\s_-]*\d+/i.test(p) || /^[Ss]\d{1,2}$/i.test(p));
  if (seasonFolder && parts.length >= 2) {
    const sm = seasonFolder.match(/(\d{1,2})/);
    const em = base.match(/(?:[Ee]|ep(?:isode)?[.\s_-]*)(\d{1,3})/i);
    const showIdx = parts.findIndex((p) => p === seasonFolder) - 1;
    const show = showIdx >= 0 ? clean(parts[showIdx]) : clean(parts[1] || base);
    return {
      title: clean(base),
      type: 'episode',
      library: 'series',
      show_name: show,
      season: sm ? parseInt(sm[1], 10) : 1,
      episode: em ? parseInt(em[1], 10) : 1,
      artist: null,
      album: null,
      track_num: null,
    };
  }
  return null;
}

function musicFrom(base: string, parts: string[]): ParsedMedia {
  const dash = base.match(MUSIC_DASH_RE);
  if (dash?.groups) {
    return {
      title: clean(dash.groups.title),
      type: 'track',
      library: 'music',
      show_name: null,
      season: null,
      episode: null,
      artist: clean(dash.groups.artist),
      album: clean(dash.groups.album),
      track_num: dash.groups.trackNum ? parseInt(dash.groups.trackNum, 10) : null,
    };
  }

  let artist: string | null = null;
  let album: string | null = null;
  if (parts.length >= 3) {
    const top = parts[0].toLowerCase();
    if (top === 'music' || top === 'musique' || top === 'audio') {
      artist = clean(parts[1]);
      album = clean(parts[2]);
    } else {
      artist = clean(parts[parts.length - 3]);
      album = clean(parts[parts.length - 2]);
    }
  } else if (parts.length === 2) {
    artist = clean(parts[0]);
  }

  let title = clean(base);
  let track_num: number | null = null;
  const tm = base.match(TRACK_NUM_PREFIX);
  if (tm?.groups) {
    track_num = parseInt(tm.groups.num, 10);
    title = clean(tm.groups.title.replace(/^\s*-\s*/, ''));
  }

  return {
    title,
    type: 'track',
    library: 'music',
    show_name: null,
    season: null,
    episode: null,
    artist: artist || 'Unknown Artist',
    album: album || 'Unknown Album',
    track_num,
  };
}

function movieFrom(base: string, parts: string[]): ParsedMedia {
  let title = clean(base);
  if (parts.length >= 2) {
    const folder = parts[parts.length - 2];
    if (!/^(movies|films|movie)$/i.test(folder)) {
      const folderTitle = clean(folder.replace(/\(\d{4}\)/, '').trim());
      if (folderTitle.length > 2) title = folderTitle;
    }
  }
  return {
    title,
    type: 'movie',
    library: 'movies',
    show_name: null,
    season: null,
    episode: null,
    artist: null,
    album: null,
    track_num: null,
  };
}

export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}
