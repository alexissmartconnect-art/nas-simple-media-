/**
 * Plex-style library sorting for GET /api/media.
 *
 * Pure function (no DB access) so it can be unit tested in isolation.
 * Only whitelisted columns/directions are interpolated into SQL —
 * anything else falls back to the default title ordering.
 */

export type MediaSortKey = 'title' | 'added' | 'size';
export type SortOrder = 'asc' | 'desc';

const DEFAULT_ORDER: Record<MediaSortKey, SortOrder> = {
  title: 'asc',
  added: 'desc', // recently added first, like Plex
  size: 'desc', // biggest first
};

export function parseMediaSort(raw: unknown): MediaSortKey {
  const v = String(raw || 'title').toLowerCase();
  if (v === 'added' || v === 'recent' || v === 'date') return 'added';
  if (v === 'size' || v === 'size_bytes') return 'size';
  return 'title';
}

export function parseSortOrder(raw: unknown, sortKey: MediaSortKey): SortOrder {
  const v = String(raw || '').toLowerCase();
  if (v === 'asc' || v === 'ascending') return 'asc';
  if (v === 'desc' || v === 'descending') return 'desc';
  return DEFAULT_ORDER[sortKey];
}

/** ORDER BY clause (without the keywords) for the media_items query. */
export function buildMediaOrderBy(sortKey: MediaSortKey, order: SortOrder): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  switch (sortKey) {
    case 'added':
      return `created_at ${dir}, id ${dir}`;
    case 'size':
      return `size_bytes ${dir}, title ASC`;
    case 'title':
    default:
      // Group-aware default: show/artist first, then episode/track order
      return `CASE kind WHEN 'series' THEN show_name WHEN 'music' THEN artist ELSE title END ${dir},
         season, episode, album, track_num, title ${dir}`;
  }
}
