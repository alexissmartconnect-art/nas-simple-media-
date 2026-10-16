import { getDb, type MediaItem } from '../db/schema';

/**
 * Playback progress / resume — Plex-like "Continue Watching" (On Deck).
 *
 * - Positions < 10s are ignored (never started).
 * - Positions > 95% of duration mark the item as watched.
 * - Watched items leave "Continue watching" but keep their flag.
 */

const MIN_POSITION_MS = 10_000;
const WATCHED_RATIO = 0.95;

export interface ProgressEntry {
  media_id: number;
  position_ms: number;
  duration_ms: number;
  watched: boolean;
  updated_at: string;
}

export function saveProgress(
  userId: number,
  mediaId: number,
  positionMs: number,
  durationMs: number
): ProgressEntry | null {
  const db = getDb();
  const pos = Math.max(0, Math.floor(positionMs || 0));
  const dur = Math.max(0, Math.floor(durationMs || 0));

  const item = db.prepare('SELECT id FROM media_items WHERE id = ?').get(mediaId) as
    | { id: number }
    | undefined;
  if (!item) return null;

  if (pos < MIN_POSITION_MS && dur > 0) {
    // Too early — clear any stale resume point but keep watched state untouched
    db.prepare('DELETE FROM playback_progress WHERE user_id = ? AND media_id = ? AND watched = 0').run(
      userId,
      mediaId
    );
    return null;
  }

  const watched = dur > 0 && pos >= dur * WATCHED_RATIO ? 1 : 0;
  db.prepare(
    `INSERT INTO playback_progress (user_id, media_id, position_ms, duration_ms, watched, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, media_id) DO UPDATE SET
       position_ms = excluded.position_ms,
       duration_ms = excluded.duration_ms,
       watched = excluded.watched,
       updated_at = excluded.updated_at`
  ).run(userId, mediaId, watched ? dur : pos, dur, watched);

  return getProgress(userId, mediaId);
}

export function getProgress(userId: number, mediaId: number): ProgressEntry | null {
  const row = getDb()
    .prepare('SELECT media_id, position_ms, duration_ms, watched, updated_at FROM playback_progress WHERE user_id = ? AND media_id = ?')
    .get(userId, mediaId) as
    | { media_id: number; position_ms: number; duration_ms: number; watched: number; updated_at: string }
    | undefined;
  if (!row) return null;
  return {
    media_id: row.media_id,
    position_ms: row.position_ms,
    duration_ms: row.duration_ms,
    watched: row.watched === 1,
    updated_at: row.updated_at,
  };
}

export function clearProgress(userId: number, mediaId: number): void {
  getDb()
    .prepare('DELETE FROM playback_progress WHERE user_id = ? AND media_id = ?')
    .run(userId, mediaId);
}

export type ContinueWatchingItem = MediaItem & {
  position_ms: number;
  duration_ms: number;
  progress_ratio: number;
  progress_updated_at: string;
};

export function listContinueWatching(userId: number, allowedLibraryIds: number[], limit = 20): ContinueWatchingItem[] {
  if (!allowedLibraryIds.length) return [];
  const ph = allowedLibraryIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT m.*, p.position_ms, p.duration_ms, p.updated_at AS progress_updated_at
       FROM playback_progress p
       JOIN media_items m ON m.id = p.media_id
       WHERE p.user_id = ? AND p.watched = 0 AND p.position_ms >= ?
         AND m.library_id IN (${ph})
       ORDER BY p.updated_at DESC
       LIMIT ?`
    )
    .all(userId, MIN_POSITION_MS, ...allowedLibraryIds, Math.min(limit, 50)) as Array<
    MediaItem & { position_ms: number; duration_ms: number; progress_updated_at: string }
  >;
  return rows.map((r) => ({
    ...r,
    progress_ratio: r.duration_ms > 0 ? Math.min(1, r.position_ms / r.duration_ms) : 0,
  }));
}

export function listRecentlyAdded(allowedLibraryIds: number[], limit = 20): MediaItem[] {
  if (!allowedLibraryIds.length) return [];
  const ph = allowedLibraryIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT * FROM media_items WHERE library_id IN (${ph})
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...allowedLibraryIds, Math.min(limit, 50)) as MediaItem[];
}
