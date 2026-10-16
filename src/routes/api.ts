import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { getDb, type MediaItem } from '../db/schema';
import { createSession, destroySession, getSessionUser } from '../auth/session';
import {
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from '../auth/rateLimit';
import { requireAuth, requireAdmin, type AuthedRequest } from '../middleware/auth';
import { scanLibrary, startFileWatch } from '../scanner/scan';
import {
  createShare,
  listShares,
  revokeShare,
  resolveShare,
  resolveShareItem,
  consumeShareUse,
  assertCanCreateShare,
  browseLibraryFolder,
  listShareItems,
  type CreateShareInput,
} from '../shares/shares';
import {
  generateQrSvg,
  resolvePublicBaseUrl,
  setCustomPublicBaseUrl,
  qrApiUrl,
} from '../shares/qr';
import { streamFile, isPathAllowed } from './stream';
import {
  authenticate,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  changeOwnPassword,
  setUserLibraries,
  getUserLibraryIds,
} from '../users/users';
import {
  listLibrariesForUser,
  listAllLibraries,
  createLibrary,
  updateLibrary,
  deleteLibrary,
  getLibrary,
  userCanAccessLibrary,
  libraryWithStats,
  getLibraryAccessMap,
} from '../libraries/libraries';
import {
  createStreamToken,
  resolveStreamToken,
  buildRawStreamUrl,
  buildShareRawStreamUrl,
  buildM3uContent,
  buildMultiM3uContent,
} from '../auth/streamTokens';
import { getPlaybackHint } from '../transcode/formats';
import {
  ensureTranscode,
  getJobStatus,
  getSegmentFile,
  readPlaylist,
  isTranscodeEnabled,
  touchJob,
  listTranscodeJobs,
  activeTranscodeCount,
  killTranscodeJob,
} from '../transcode/hls';
import {
  parseProfileFromQuery,
  decideHls,
  modeLabel,
  profileLabel,
  type SessionProfile,
} from '../transcode/decision';
import {
  ensureProbeForItem,
  getCachedProbe,
  summarizeProbe,
  audioTrackLabel,
  subtitleTrackLabel,
  videoTrackLabel,
} from '../media/probe';
import { ensureThumb, thumbCacheKey } from '../media/thumbs';
import { ensureSubtitleVtt, checkSubtitle } from '../media/subtitles';
import {
  saveProgress,
  getProgress,
  clearProgress,
  listContinueWatching,
  listRecentlyAdded,
} from '../playback/progress';
import { parseMediaSort, parseSortOrder, buildMediaOrderBy } from './mediaSort';
import fs from 'fs';
import path from 'path';

export const apiRouter = Router();

function okUser(req: AuthedRequest) {
  return req.user;
}

function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function shareClientKey(req: Request): string {
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 80);
  return `${ip}|${ua}`;
}

function publicBase(req: Request): string {
  return resolvePublicBaseUrl(req);
}

function shareLink(token: string, req: Request): string {
  return `${publicBase(req)}/s/${token}`;
}

function pipeSegmentFile(file: string, contentType: string, res: Response, cacheHeader?: string): void {
  res.setHeader('Content-Type', contentType);
  if (cacheHeader) {
    res.setHeader('Cache-Control', cacheHeader);
  }
  const stream = fs.createReadStream(file);
  const cleanup = () => {
    if (!stream.destroyed) stream.destroy();
  };
  res.on('close', cleanup);
  stream.on('error', () => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Segment read error' });
    else res.end();
  });
  stream.pipe(res);
}

apiRouter.post('/login', (req, res) => {
  const username = String(req.body?.username || 'admin').trim();
  const password = String(req.body?.password || '');
  const rateKey = `login:${clientIp(req)}:${username.toLowerCase()}`;

  const rl = isRateLimited(rateKey);
  if (rl.limited) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    res.status(429).json({
      error: `Trop de tentatives. Réessayez dans ${rl.retryAfterSec}s.`,
    });
    return;
  }

  const user = authenticate(username, password);
  if (!user) {
    recordFailedAttempt(rateKey);
    res.status(401).json({ error: 'Identifiants incorrects' });
    return;
  }

  clearFailedAttempts(rateKey);
  const token = createSession(user);
  res.cookie(config.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.SESSION_MAX_AGE_MS,
    path: '/',
  });
  res.json({ ok: true, user });
});

apiRouter.post('/logout', (req, res) => {
  destroySession(req.cookies?.[config.COOKIE_NAME]);
  res.clearCookie(config.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

apiRouter.get('/me', (req, res) => {
  const user = getSessionUser(req.cookies?.[config.COOKIE_NAME]);
  res.json({ authenticated: !!user, user: user || null });
});

apiRouter.post('/me/password', requireAuth, (req, res) => {
  try {
    const user = okUser(req as AuthedRequest);
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    changeOwnPassword(user.id, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.get('/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '');
    const svg = await generateQrSvg(text);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.get('/folders', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const libraryId = Number(req.query.library_id);
  if (!libraryId) {
    res.status(400).json({ error: 'library_id requis' });
    return;
  }
  if (!userCanAccessLibrary(user, libraryId)) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }
  const folderPath = String(req.query.path || '');
  try {
    res.json(browseLibraryFolder(libraryId, folderPath));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ---- Libraries (user-visible) ----
apiRouter.get('/libraries', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const libs = listLibrariesForUser(user).map(libraryWithStats);
  res.json({ libraries: libs });
});

apiRouter.get('/media', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const db = getDb();
  const libraryId = req.query.library_id ? Number(req.query.library_id) : undefined;
  const kind = req.query.kind as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();
  const show = req.query.show as string | undefined;
  const artist = req.query.artist as string | undefined;
  const album = req.query.album as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
  const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

  const allowed = listLibrariesForUser(user).map((l) => l.id);
  if (!allowed.length) {
    res.json({ items: [], total: 0, limit, offset });
    return;
  }

  if (libraryId && !userCanAccessLibrary(user, libraryId)) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (libraryId) {
    where.push('library_id = ?');
    params.push(libraryId);
  } else {
    where.push(`library_id IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (show) {
    where.push('show_name = ?');
    params.push(show);
  }
  if (artist) {
    where.push('artist = ?');
    params.push(artist);
  }
  if (album) {
    where.push('album = ?');
    params.push(album);
  }
  if (q) {
    where.push('(title LIKE ? OR show_name LIKE ? OR artist LIKE ? OR album LIKE ? OR filename LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const sortKey = parseMediaSort(req.query.sort);
  const sortOrder = parseSortOrder(req.query.order, sortKey);
  const orderBy = buildMediaOrderBy(sortKey, sortOrder);
  const items = db
    .prepare(
      `SELECT * FROM media_items ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as MediaItem[];

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM media_items ${whereSql}`).get(...params) as { c: number }
  ).c;

  res.json({ items, total, limit, offset, sort: sortKey, order: sortOrder });
});

/**
 * Plex-like "preplay" payload: real codecs (ffprobe), audio/subtitle tracks,
 * surround availability, resume point. Probing is cached — first call on a
 * file pays one fast ffprobe run, later calls are instant.
 */
async function mediaDetailPayload(
  user: ReturnType<typeof okUser>,
  item: MediaItem
): Promise<Record<string, unknown>> {
  let probe = getCachedProbe(item);
  if (!probe && config.PROBE_ENABLED) {
    probe = await ensureProbeForItem(item);
  }
  const summary = probe ? summarizeProbe(probe) : null;
  const playback = getPlaybackHint(item.filename || item.path, item.type, summary);
  const progress = user ? getProgress(user.id, item.id) : null;
  return {
    ...item,
    playback,
    transcodeEnabled: isTranscodeEnabled(),
    probeAvailable: !!probe,
    summary,
    video: probe ? probe.video.map((v) => ({ ...v, label: videoTrackLabel(v) })) : [],
    audio: probe ? probe.audio.map((a) => ({ ...a, label: audioTrackLabel(a) })) : [],
    subtitles: probe
      ? probe.subtitles.map((s) => ({ ...s, label: subtitleTrackLabel(s) }))
      : [],
    hasThumb: item.type !== 'track' && config.THUMBS_ENABLED,
    passthroughAllowed: config.TRANSCODE_AUDIO_PASSTHROUGH,
    progress,
  };
}

apiRouter.get('/media/:id', requireAuth, async (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getDb()
    .prepare('SELECT * FROM media_items WHERE id = ?')
    .get(Number(req.params.id)) as MediaItem | undefined;
  if (!item || !userCanAccessLibrary(user, item.library_id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(await mediaDetailPayload(user, item));
});

/** Streams + transcode decision for one profile (drives the player's selectors). */
apiRouter.get('/media/:id/streams', requireAuth, async (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  let probe = getCachedProbe(item);
  if (!probe && config.PROBE_ENABLED) {
    probe = await ensureProbeForItem(item);
  }
  const summary = probe ? summarizeProbe(probe) : null;
  const decision = decideHls(probe, item.filename || item.path, profile);
  res.json({
    profile,
    profileLabel: profileLabel(profile),
    decision: { ...decision, modeLabel: modeLabel(decision.mode) },
    probeAvailable: !!probe,
    summary,
    audio: probe ? probe.audio.map((a) => ({ ...a, label: audioTrackLabel(a) })) : [],
    subtitles: probe
      ? probe.subtitles.map((s) => ({ ...s, label: subtitleTrackLabel(s) }))
      : [],
    passthroughAllowed: config.TRANSCODE_AUDIO_PASSTHROUGH,
    qualities: ['original', '1080p', '720p', '480p'],
  });
});

/** Video thumbnail (Plex-like poster), generated once then cached. */
apiRouter.get('/media/:id/thumb.jpg', requireAuth, async (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item || item.type === 'track') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const key = thumbCacheKey(item);
  if (req.headers['if-none-match'] === key) {
    res.status(304).end();
    return;
  }
  const file = await ensureThumb(item);
  if (!file) {
    res.status(404).json({ error: 'Thumbnail unavailable' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('ETag', key);
  pipeSegmentFile(file, 'image/jpeg', res);
});

/** Embedded subtitle extracted to WebVTT. */
apiRouter.get('/media/:id/subtitles/:index.vtt', requireAuth, async (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index > 31) {
    res.status(400).json({ error: 'Invalid subtitle index' });
    return;
  }
  const avail = await checkSubtitle(item, index);
  if (!avail.ok) {
    res.status(404).json({ error: avail.reason || 'Subtitle unavailable' });
    return;
  }
  const file = await ensureSubtitleVtt(item, index);
  if (!file) {
    res.status(503).json({ error: 'Extraction failed — ffmpeg requis' });
    return;
  }
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  pipeSegmentFile(file, 'text/vtt; charset=utf-8', res);
});

// ---- Playback progress (Continue watching / resume) ----
apiRouter.post('/media/:id/progress', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const positionMs = Number(req.body?.positionMs ?? req.body?.position_ms ?? 0);
  const durationMs = Number(req.body?.durationMs ?? req.body?.duration_ms ?? 0);
  const p = saveProgress(user.id, item.id, positionMs, durationMs);
  res.json({ ok: true, progress: p });
});

apiRouter.delete('/media/:id/progress', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  clearProgress(user.id, Number(req.params.id));
  res.json({ ok: true });
});

apiRouter.get('/continue-watching', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const allowed = listLibrariesForUser(user).map((l) => l.id);
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 50);
  const items = listContinueWatching(user.id, allowed, limit).map((it) => ({
    ...it,
    playback: getPlaybackHint(it.filename || it.path, it.type),
  }));
  res.json({ items });
});

apiRouter.get('/recently-added', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const allowed = listLibrariesForUser(user).map((l) => l.id);
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 50);
  const items = listRecentlyAdded(allowed, limit).map((it) => ({
    ...it,
    playback: getPlaybackHint(it.filename || it.path, it.type),
  }));
  res.json({ items });
});

// ---- Admin: live transcode sessions (Plex-like dashboard) ----
apiRouter.get('/admin/sessions', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    jobs: listTranscodeJobs(),
    activeCount: activeTranscodeCount(),
    maxJobs: config.TRANSCODE_MAX_JOBS,
    hwaccel: config.TRANSCODE_HWACCEL,
  });
});

apiRouter.delete('/admin/sessions/:key', requireAuth, requireAdmin, (req, res) => {
  const ok = killTranscodeJob(String(req.params.key));
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ ok: true });
});

apiRouter.get('/series', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const allowed = listLibrariesForUser(user)
    .filter((l) => l.type === 'series')
    .map((l) => l.id);
  if (!allowed.length) {
    res.json({ shows: [] });
    return;
  }
  const libraryId = req.query.library_id ? Number(req.query.library_id) : undefined;
  if (libraryId && !allowed.includes(libraryId)) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }
  const ids = libraryId ? [libraryId] : allowed;
  const ph = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT show_name as name, COUNT(*) as episodes, COUNT(DISTINCT season) as seasons, library_id
       FROM media_items WHERE kind = 'series' AND show_name IS NOT NULL AND library_id IN (${ph})
       GROUP BY library_id, show_name ORDER BY show_name`
    )
    .all(...ids);
  res.json({ shows: rows });
});

apiRouter.get('/artists', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const allowed = listLibrariesForUser(user)
    .filter((l) => l.type === 'music')
    .map((l) => l.id);
  if (!allowed.length) {
    res.json({ artists: [] });
    return;
  }
  const libraryId = req.query.library_id ? Number(req.query.library_id) : undefined;
  if (libraryId && !allowed.includes(libraryId)) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }
  const ids = libraryId ? [libraryId] : allowed;
  const ph = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT artist as name, COUNT(*) as tracks, COUNT(DISTINCT album) as albums, library_id
       FROM media_items WHERE kind = 'music' AND artist IS NOT NULL AND library_id IN (${ph})
       GROUP BY library_id, artist ORDER BY artist`
    )
    .all(...ids);
  res.json({ artists: rows });
});

function getAccessibleMedia(user: ReturnType<typeof okUser>, id: number): MediaItem | null {
  const item = getDb()
    .prepare('SELECT * FROM media_items WHERE id = ?')
    .get(id) as MediaItem | undefined;
  if (!item || !userCanAccessLibrary(user, item.library_id)) return null;
  return item;
}

function authStreamOrToken(
  req: Request,
  res: Response,
  mediaId: number,
  scope: 'raw' | 'download' | 'hls'
): MediaItem | null {
  const qToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  if (qToken) {
    const data = resolveStreamToken(qToken, { mediaId, scope });
    if (!data) {
      res.status(401).json({ error: 'Invalid or expired stream token' });
      return null;
    }
    const item = getDb()
      .prepare('SELECT * FROM media_items WHERE id = ?')
      .get(mediaId) as MediaItem | undefined;
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    const lib = getLibrary(item.library_id);
    if (!lib || !lib.enabled) {
      res.status(403).json({ error: 'Library disabled' });
      return null;
    }
    if (data.userId != null) {
      const u = getUser(data.userId);
      if (!u || !u.enabled) {
        res.status(401).json({ error: 'User disabled' });
        return null;
      }
      const sessionUser = {
        id: u.id,
        username: u.username,
        role: u.role,
        can_share: !!u.can_share,
      };
      if (!userCanAccessLibrary(sessionUser, item.library_id)) {
        res.status(403).json({ error: 'Accès refusé' });
        return null;
      }
    }
    return item;
  }
  const user = getSessionUser(req.cookies?.[config.COOKIE_NAME]);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const item = getAccessibleMedia(user, mediaId);
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return item;
}

apiRouter.get('/stream/:id', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isPathAllowed(item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  streamFile(item.path, req, res);
});

/** Original file with Range — cookie or ?token= (for VLC). */
apiRouter.get('/stream/:id/raw', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'raw');
  if (!item) return;
  if (!isPathAllowed(item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  streamFile(item.path, req, res);
});

/** Download original file (attachment). */
apiRouter.get('/media/:id/download', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isPathAllowed(item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  streamFile(item.path, req, res, { download: true, filename: item.filename });
});

/** Issue VLC / external player URLs + optional .m3u. */
apiRouter.get('/media/:id/vlc', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getAccessibleMedia(user, Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const token = createStreamToken({ mediaId: item.id, userId: user.id, scope: 'raw' });
  const base = publicBase(req);
  const streamUrl = buildRawStreamUrl(item.id, token, base);
  const m3uUrl = `${base}/api/media/${item.id}/playlist.m3u?token=${encodeURIComponent(token)}`;
  res.json({
    streamUrl,
    m3uUrl,
    qrUrl: qrApiUrl(streamUrl),
    vlcUri: `vlc://${streamUrl.replace(/^https?:\/\//, '')}`,
    help:
      'Dans VLC : Média → Ouvrir un flux réseau → collez streamUrl. Ou en CLI : vlc "<streamUrl>". ' +
      'Le fichier .m3u ouvre directement le flux authentifié. VLC lit le bitstream original (DTS/TrueHD/AC-3 5.1) ; le mode Compatible propose Stéréo ou Surround 5.1 (DTS → AAC 5.1).',
    expiresInMs: config.STREAM_TOKEN_TTL_MS,
  });
});

apiRouter.get('/media/:id/playlist.m3u', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'raw');
  if (!item) return;
  const qToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  let token = qToken;
  if (!token) {
    const user = getSessionUser(req.cookies?.[config.COOKIE_NAME]);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    token = createStreamToken({ mediaId: item.id, userId: user.id, scope: 'raw' });
  }
  const streamUrl = buildRawStreamUrl(item.id, token, publicBase(req));
  const body = buildM3uContent(item.title, streamUrl);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent((item.title || 'media').replace(/[^\w.\- ]+/g, '_') + '.m3u')}`
  );
  res.send(body);
});

/** Resolve the cached probe for an HLS session (never blocks on a fresh probe). */
function hlsProbeFor(item: MediaItem) {
  const cached = getCachedProbe(item);
  if (cached) return cached;
  if (config.PROBE_ENABLED) {
    // Kick off a background probe so the NEXT session can Direct Stream.
    ensureProbeForItem(item).catch(() => {});
  }
  return null;
}

function profileQueryString(profile: SessionProfile): string {
  const parts: string[] = [];
  if (profile.quality !== 'original') parts.push(`quality=${profile.quality}`);
  if (profile.audioIndex !== 0) parts.push(`audio=${profile.audioIndex}`);
  if (profile.surround) parts.push('surround=1');
  if (profile.passthrough) parts.push('passthrough=1');
  return parts.join('&');
}

/** HLS Compatible mode — start ffmpeg job + return status / playlist URL. */
apiRouter.get('/stream/:id/hls', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'hls');
  if (!item) return;
  if (item.type === 'track') {
    res.status(400).json({ error: 'HLS Compatible est réservé à la vidéo' });
    return;
  }
  if (!isPathAllowed(item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  if (!isTranscodeEnabled()) {
    res.status(503).json({
      error: 'Transcodage désactivé. Utilisez Direct ou VLC.',
      enabled: false,
    });
    return;
  }
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const probe = hlsProbeFor(item);
  const decision = decideHls(probe, item.filename || item.path, profile);
  const st = ensureTranscode(mediaId, item.path, {
    profile,
    probe,
    filename: item.filename || item.path,
  });
  const qToken = typeof req.query.token === 'string' ? req.query.token : '';
  const qsParts: string[] = [];
  if (qToken) qsParts.push(`token=${encodeURIComponent(qToken)}`);
  const pq = profileQueryString(profile);
  if (pq) qsParts.push(pq);
  const qs = qsParts.length ? `?${qsParts.join('&')}` : '';
  res.json({
    ...st,
    playlistUrl: `/api/stream/${mediaId}/hls/playlist.m3u8${qs}`,
    decision: { ...decision, modeLabel: modeLabel(decision.mode) },
    note: decision.mode === 'direct-stream'
      ? 'Remux direct : vidéo copiée sans ré-encodage, audio converti si besoin (DTS → AAC 5.1 en Surround).'
      : 'Compatible = H.264 + AAC (Stéréo par défaut, Surround 5.1 si demandé). DTS/TrueHD préservés en multicanal.',
  });
});

apiRouter.get('/stream/:id/hls/playlist.m3u8', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'hls');
  if (!item) return;
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé' });
    return;
  }
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  ensureTranscode(mediaId, item.path, {
    profile,
    probe: hlsProbeFor(item),
    filename: item.filename || item.path,
  });
  const qToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const segQs: string[] = [];
  if (qToken) segQs.push(`token=${encodeURIComponent(qToken)}`);
  const pq = profileQueryString(profile);
  if (pq) segQs.push(pq);
  const body = readPlaylist(mediaId, segQs.join('&') || undefined, profile);
  if (!body) {
    res.status(202).json({
      error: 'Transcodage en cours',
      status: getJobStatus(mediaId, profile).status,
      retryAfterMs: 1500,
    });
    return;
  }
  touchJob(mediaId, profile);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
});

apiRouter.get('/stream/:id/hls/:segment', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'hls');
  if (!item) return;
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const name = path.basename(req.params.segment);
  const file = getSegmentFile(mediaId, name, profile);
  if (!file) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  touchJob(mediaId, profile);
  const ct = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : 'application/octet-stream';
  pipeSegmentFile(file, ct, res, 'private, max-age=3600');
});

apiRouter.get('/status', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const libs = listLibrariesForUser(user);
  const db = getDb();
  const counts = libs.map((l) => {
    const c = (
      db.prepare(`SELECT COUNT(*) as c FROM media_items WHERE library_id = ?`).get(l.id) as { c: number }
    ).c;
    return { library_id: l.id, name: l.name, type: l.type, count: c };
  });
  const last = db.prepare(`SELECT value FROM scan_meta WHERE key = 'last_scan'`).get() as
    | { value: string }
    | undefined;
  res.json({
    mediaPath: config.MEDIA_PATH,
    publicBaseUrl: resolvePublicBaseUrl(req),
    counts,
    lastScan: last?.value || null,
    user,
    transcode: {
      enabled: isTranscodeEnabled(),
      maxJobs: config.TRANSCODE_MAX_JOBS,
      ffmpegPath: config.FFMPEG_PATH,
      hwaccel: config.TRANSCODE_HWACCEL,
      videoCopy: config.TRANSCODE_VIDEO_COPY,
      surroundCodec: config.TRANSCODE_SURROUND_CODEC,
      passthroughAllowed: config.TRANSCODE_AUDIO_PASSTHROUGH,
      probeEnabled: config.PROBE_ENABLED,
      thumbsEnabled: config.THUMBS_ENABLED,
      qualities: ['original', '1080p', '720p', '480p'],
    },
  });
});

// ---- Shares ----
apiRouter.get('/shares', requireAuth, (req, res) => {
  const base = publicBase(req);
  const shares = listShares(okUser(req as AuthedRequest)).map((s) => {
    const url = `${base}/s/${s.token}`;
    return { ...s, url, qrUrl: qrApiUrl(url) };
  });
  res.json({ shares, publicBaseUrl: base });
});

apiRouter.post('/shares', requireAuth, (req, res) => {
  try {
    const user = okUser(req as AuthedRequest);
    const targetType = (req.body?.targetType || (req.body?.mediaId ? 'media' : '')) as CreateShareInput['targetType'];
    const input: CreateShareInput = {
      targetType: targetType || 'media',
      mediaId: req.body?.mediaId != null && req.body.mediaId !== '' ? Number(req.body.mediaId) : undefined,
      libraryId: req.body?.libraryId != null && req.body.libraryId !== '' ? Number(req.body.libraryId) : undefined,
      folderPath: req.body?.folderPath || undefined,
      showName: req.body?.showName || undefined,
      season: req.body?.season != null && req.body.season !== '' ? Number(req.body.season) : undefined,
      artist: req.body?.artist || undefined,
      album: req.body?.album || undefined,
      label: req.body?.label || undefined,
      expiresAt: req.body?.expiresAt || null,
      maxUses: req.body?.maxUses != null && req.body.maxUses !== '' ? Number(req.body.maxUses) : null,
      password: req.body?.password || null,
      createdBy: user.id,
    };
    if (input.targetType === 'media' && !input.mediaId) {
      res.status(400).json({ error: 'mediaId required' });
      return;
    }
    assertCanCreateShare(user, input);
    const share = createShare(input, publicBase(req));
    const url = share.url;
    res.status(201).json({ ...share, url, qrUrl: qrApiUrl(url) });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.delete('/shares/:id', requireAuth, (req, res) => {
  const ok = revokeShare(Number(req.params.id), okUser(req as AuthedRequest));
  if (!ok) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ok: true });
});

// ---- Admin: scan ----
apiRouter.post('/rescan', requireAuth, requireAdmin, (req, res) => {
  try {
    const libraryId = req.body?.libraryId ? Number(req.body.libraryId) : undefined;
    const result = scanLibrary(libraryId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Admin: users ----
apiRouter.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const access = getLibraryAccessMap();
  const users = listUsers().map((u) => ({ ...u, library_ids: access[u.id] || [] }));
  res.json({ users });
});

apiRouter.post('/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const user = createUser({
      username: String(req.body?.username || ''),
      password: String(req.body?.password || ''),
      role: req.body?.role === 'admin' ? 'admin' : 'user',
      can_share: req.body?.can_share !== false,
    });
    if (Array.isArray(req.body?.library_ids)) {
      setUserLibraries(user.id, req.body.library_ids.map(Number));
    }
    res.status(201).json({
      ...user,
      library_ids: getUserLibraryIds(user.id),
    });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.patch('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = updateUser(id, {
      password: req.body?.password || undefined,
      role: req.body?.role,
      enabled: req.body?.enabled,
      can_share: req.body?.can_share,
    });
    if (Array.isArray(req.body?.library_ids)) {
      setUserLibraries(id, req.body.library_ids.map(Number));
    }
    res.json({ ...user, library_ids: getUserLibraryIds(id) });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const actor = okUser(req as AuthedRequest);
    const id = Number(req.params.id);
    const ok = deleteUser(id, actor.id);
    if (!ok) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.put('/admin/users/:id/libraries', requireAuth, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const ids = Array.isArray(req.body?.library_ids) ? req.body.library_ids.map(Number) : [];
    setUserLibraries(id, ids);
    res.json({ ok: true, library_ids: getUserLibraryIds(id) });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ---- Admin: libraries ----
apiRouter.get('/admin/libraries', requireAuth, requireAdmin, (_req, res) => {
  res.json({ libraries: listAllLibraries().map(libraryWithStats) });
});

apiRouter.post('/admin/libraries', requireAuth, requireAdmin, (req, res) => {
  try {
    const lib = createLibrary({
      name: String(req.body?.name || ''),
      type: req.body?.type,
      path: String(req.body?.path || ''),
    });
    res.status(201).json(libraryWithStats(lib));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.patch('/admin/libraries/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const lib = updateLibrary(Number(req.params.id), {
      name: req.body?.name,
      path: req.body?.path,
      enabled: req.body?.enabled,
    });
    res.json(libraryWithStats(lib));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

apiRouter.delete('/admin/libraries/:id', requireAuth, requireAdmin, (req, res) => {
  const ok = deleteLibrary(Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ok: true });
});

apiRouter.put('/admin/settings/public-url', requireAuth, requireAdmin, (req, res) => {
  try {
    const raw = req.body?.publicBaseUrl ?? req.body?.public_base_url ?? null;
    const saved = setCustomPublicBaseUrl(raw === '' ? null : raw);
    const url = saved || resolvePublicBaseUrl(req);
    res.json({ ok: true, publicBaseUrl: url });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ---- Public share helpers ----
function checkPublicShareAccess(req: Request, res: Response) {
  const token = req.params.token;
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const rateKey = `share:${clientIp(req)}:${token}`;

  const rl = isRateLimited(rateKey);
  if (rl.limited) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    res.status(429).json({
      error: `Trop de tentatives. Réessayez dans ${rl.retryAfterSec}s.`,
    });
    return null;
  }

  const cKey = shareClientKey(req);
  const access = resolveShare(token, password, cKey);
  if (!access.ok) {
    if (access.badPassword) {
      recordFailedAttempt(rateKey);
    }
    res.status(403).json({ error: access.reason });
    return null;
  }
  if (!access.needsPassword && password) {
    clearFailedAttempts(rateKey);
  }
  return { access, password, clientKey: cKey };
}

function enrichShareItem(item: MediaItem) {
  return {
    ...item,
    playback: getPlaybackHint(item.filename || item.path, item.type),
  };
}

function sendShareItemNotFound(res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

// ---- Public share routes ----
apiRouter.get('/public/share/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access } = checked;
  if (access.needsPassword) {
    res.json({
      needsPassword: true,
      title: access.title,
      type: access.media?.type,
      targetType: access.share.target_type,
      shareTitle: access.title,
    });
    return;
  }
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const subfolder = typeof req.query.subfolder === 'string' ? req.query.subfolder : undefined;
  const items = q || subfolder ? listShareItems(access.share, { q, subfolder }) : access.items;
  const first = items[0] || access.media;
  const playback = first ? getPlaybackHint(first.filename || first.path, first.type) : null;
  const shareUrl = shareLink(req.params.token, req);
  res.json({
    needsPassword: false,
    id: first?.id,
    title: first?.title || access.title,
    type: first?.type,
    kind: first?.kind,
    artist: first?.artist ?? access.share.artist,
    album: first?.album ?? access.share.album,
    show_name: first?.show_name ?? access.share.show_name,
    season: first?.season ?? access.share.season,
    episode: first?.episode,
    filename: first?.filename,
    size_bytes: first?.size_bytes,
    playback,
    transcodeEnabled: isTranscodeEnabled(),
    targetType: access.share.target_type,
    shareTitle: access.title,
    folderPath: access.share.folder_path,
    itemCount: items.length,
    shareUrl,
    qrUrl: qrApiUrl(shareUrl),
    items: items.map(enrichShareItem),
  });
});

function loadPublicShareItem(req: Request, res: Response) {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return null;
  const { access, password, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return null;
  }
  const mediaId = Number(req.params.mediaId);
  const item = resolveShareItem(access.share, mediaId);
  if (!item) {
    sendShareItemNotFound(res);
    return null;
  }
  return { access, password, clientKey, item };
}

apiRouter.get('/public/share/:token/item/:mediaId/stream', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  if (!isPathAllowed(loaded.item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  consumeShareUse(req.params.token, loaded.clientKey);
  streamFile(loaded.item.path, req, res);
});

apiRouter.get('/public/share/:token/item/:mediaId/download', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  if (!isPathAllowed(loaded.item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  consumeShareUse(req.params.token, loaded.clientKey);
  streamFile(loaded.item.path, req, res, {
    download: true,
    filename: loaded.item.filename,
  });
});

apiRouter.get('/public/share/:token/item/:mediaId/vlc', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  const base = publicBase(req);
  const streamUrl = buildShareRawStreamUrl(req.params.token, loaded.password, loaded.item.id, base);
  const m3uUrl =
    `${base}/api/public/share/${encodeURIComponent(req.params.token)}/item/${loaded.item.id}/playlist.m3u` +
    (loaded.password ? `?password=${encodeURIComponent(loaded.password)}` : '');
  res.json({
    streamUrl,
    m3uUrl,
    qrUrl: qrApiUrl(streamUrl),
    vlcUri: `vlc://${streamUrl.replace(/^https?:\/\//, '')}`,
    help:
      'VLC : Média → Ouvrir un flux réseau, ou téléchargez le .m3u. VLC lit le fichier original (DTS 5.1 inclus).',
  });
});

apiRouter.get('/public/share/:token/item/:mediaId/playlist.m3u', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  const streamUrl = buildShareRawStreamUrl(
    req.params.token,
    loaded.password,
    loaded.item.id,
    publicBase(req)
  );
  const body = buildM3uContent(loaded.item.title, streamUrl);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent((loaded.item.title || 'share').replace(/[^\w.\- ]+/g, '_') + '.m3u')}`
  );
  res.send(body);
});

apiRouter.get('/public/share/:token/item/:mediaId/hls', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  if (loaded.item.type === 'track') {
    res.status(400).json({ error: 'HLS Compatible est réservé à la vidéo' });
    return;
  }
  if (!isPathAllowed(loaded.item.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé', enabled: false });
    return;
  }
  consumeShareUse(req.params.token, loaded.clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const probe = hlsProbeFor(loaded.item);
  const decision = decideHls(probe, loaded.item.filename || loaded.item.path, profile);
  const st = ensureTranscode(loaded.item.id, loaded.item.path, {
    profile,
    probe,
    filename: loaded.item.filename || loaded.item.path,
  });
  const qsParts: string[] = [];
  if (loaded.password) qsParts.push(`password=${encodeURIComponent(loaded.password)}`);
  const pq = profileQueryString(profile);
  if (pq) qsParts.push(pq);
  const qs = qsParts.length ? `?${qsParts.join('&')}` : '';
  res.json({
    ...st,
    playlistUrl: `/api/public/share/${encodeURIComponent(req.params.token)}/item/${loaded.item.id}/hls/playlist.m3u8${qs}`,
    decision: { ...decision, modeLabel: modeLabel(decision.mode) },
  });
});

apiRouter.get('/public/share/:token/item/:mediaId/hls/playlist.m3u8', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé' });
    return;
  }
  consumeShareUse(req.params.token, loaded.clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  ensureTranscode(loaded.item.id, loaded.item.path, {
    profile,
    probe: hlsProbeFor(loaded.item),
    filename: loaded.item.filename || loaded.item.path,
  });
  const segQs: string[] = [];
  if (loaded.password) segQs.push(`password=${encodeURIComponent(loaded.password)}`);
  const pq = profileQueryString(profile);
  if (pq) segQs.push(pq);
  const body = readPlaylist(loaded.item.id, segQs.join('&') || undefined, profile);
  if (!body) {
    res.status(202).json({
      error: 'Transcodage en cours',
      status: getJobStatus(loaded.item.id, profile).status,
      retryAfterMs: 1500,
    });
    return;
  }
  touchJob(loaded.item.id, profile);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
});

apiRouter.get('/public/share/:token/item/:mediaId/hls/:segment', (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  consumeShareUse(req.params.token, loaded.clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const name = path.basename(req.params.segment);
  const file = getSegmentFile(loaded.item.id, name, profile);
  if (!file) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  touchJob(loaded.item.id, profile);
  const ct = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : 'application/octet-stream';
  pipeSegmentFile(file, ct, res, 'private, max-age=3600');
});

/** Public: codec info + audio/subtitle tracks for a shared item. */
apiRouter.get('/public/share/:token/item/:mediaId/streams', async (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  let probe = getCachedProbe(loaded.item);
  if (!probe && config.PROBE_ENABLED) {
    probe = await ensureProbeForItem(loaded.item);
  }
  const summary = probe ? summarizeProbe(probe) : null;
  const decision = decideHls(probe, loaded.item.filename || loaded.item.path, profile);
  res.json({
    profile,
    profileLabel: profileLabel(profile),
    decision: { ...decision, modeLabel: modeLabel(decision.mode) },
    probeAvailable: !!probe,
    summary,
    audio: probe ? probe.audio.map((a) => ({ ...a, label: audioTrackLabel(a) })) : [],
    subtitles: probe
      ? probe.subtitles.map((s) => ({ ...s, label: subtitleTrackLabel(s) }))
      : [],
    passthroughAllowed: config.TRANSCODE_AUDIO_PASSTHROUGH,
    qualities: ['original', '1080p', '720p', '480p'],
  });
});

/** Public: thumbnail for a shared item. */
apiRouter.get('/public/share/:token/item/:mediaId/thumb.jpg', async (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  if (loaded.item.type === 'track') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const file = await ensureThumb(loaded.item);
  if (!file) {
    res.status(404).json({ error: 'Thumbnail unavailable' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  pipeSegmentFile(file, 'image/jpeg', res);
});

/** Public: embedded subtitle as WebVTT. */
apiRouter.get('/public/share/:token/item/:mediaId/subtitles/:index.vtt', async (req, res) => {
  const loaded = loadPublicShareItem(req, res);
  if (!loaded) return;
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index > 31) {
    res.status(400).json({ error: 'Invalid subtitle index' });
    return;
  }
  const avail = await checkSubtitle(loaded.item, index);
  if (!avail.ok) {
    res.status(404).json({ error: avail.reason || 'Subtitle unavailable' });
    return;
  }
  const file = await ensureSubtitleVtt(loaded.item, index);
  if (!file) {
    res.status(503).json({ error: 'Extraction failed' });
    return;
  }
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  pipeSegmentFile(file, 'text/vtt; charset=utf-8', res);
});

apiRouter.get('/public/stream/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  streamFile(access.media.path, req, res);
});

/** Alias for VLC: same as public stream (original + Range). */
apiRouter.get('/public/stream/:token/raw', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  streamFile(access.media.path, req, res);
});

apiRouter.get('/public/download/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  streamFile(access.media.path, req, res, {
    download: true,
    filename: access.media.filename,
  });
});

apiRouter.get('/public/vlc/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, password } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  const base = publicBase(req);
  const items = access.items;
  const mediaId = items.length > 1 ? items[0]?.id : undefined;
  const streamUrl = buildShareRawStreamUrl(req.params.token, password, mediaId, base);
  const m3uUrl =
    `${base}/api/public/playlist/${encodeURIComponent(req.params.token)}` +
    (password ? `?password=${encodeURIComponent(password)}` : '');
  res.json({
    streamUrl,
    m3uUrl,
    qrUrl: qrApiUrl(items.length > 1 ? m3uUrl : streamUrl),
    vlcUri: `vlc://${streamUrl.replace(/^https?:\/\//, '')}`,
    help:
      'VLC : Média → Ouvrir un flux réseau, ou téléchargez le .m3u. VLC lit le fichier original (DTS 5.1 inclus).',
  });
});

apiRouter.get('/public/playlist/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, password } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  const base = publicBase(req);
  const items = access.items;
  let body: string;
  if (items.length > 1) {
    body = buildMultiM3uContent(
      items.map((it) => ({
        title: it.title,
        streamUrl: buildShareRawStreamUrl(req.params.token, password, it.id, base),
      }))
    );
  } else {
    const streamUrl = buildShareRawStreamUrl(req.params.token, password, items[0]?.id, base);
    body = buildM3uContent(access.title || items[0]?.title || 'share', streamUrl);
  }
  const fname = (access.title || access.media?.title || 'share').replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fname + '.m3u')}`
  );
  res.send(body);
});

apiRouter.get('/public/hls/:token', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, password, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (access.media.type === 'track') {
    res.status(400).json({ error: 'HLS Compatible est réservé à la vidéo' });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé', enabled: false });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const probe = hlsProbeFor(access.media);
  const decision = decideHls(probe, access.media.filename || access.media.path, profile);
  const st = ensureTranscode(access.media.id, access.media.path, {
    profile,
    probe,
    filename: access.media.filename || access.media.path,
  });
  const qsParts: string[] = [];
  if (password) qsParts.push(`password=${encodeURIComponent(password)}`);
  const pq = profileQueryString(profile);
  if (pq) qsParts.push(pq);
  const qs = qsParts.length ? `?${qsParts.join('&')}` : '';
  res.json({
    ...st,
    playlistUrl: `/api/public/hls/${encodeURIComponent(req.params.token)}/playlist.m3u8${qs}`,
    decision: { ...decision, modeLabel: modeLabel(decision.mode) },
  });
});

apiRouter.get('/public/hls/:token/playlist.m3u8', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, password, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé' });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  ensureTranscode(access.media.id, access.media.path, {
    profile,
    probe: hlsProbeFor(access.media),
    filename: access.media.filename || access.media.path,
  });
  const segQs: string[] = [];
  if (password) segQs.push(`password=${encodeURIComponent(password)}`);
  const pq = profileQueryString(profile);
  if (pq) segQs.push(pq);
  const body = readPlaylist(access.media.id, segQs.join('&') || undefined, profile);
  if (!body) {
    res.status(202).json({
      error: 'Transcodage en cours',
      status: getJobStatus(access.media.id, profile).status,
      retryAfterMs: 1500,
    });
    return;
  }
  touchJob(access.media.id, profile);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
});

apiRouter.get('/public/hls/:token/:segment', (req, res) => {
  const checked = checkPublicShareAccess(req, res);
  if (!checked) return;
  const { access, clientKey } = checked;
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!access.media) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  consumeShareUse(req.params.token, clientKey);
  const profile = parseProfileFromQuery(req.query as Record<string, unknown>);
  const name = path.basename(req.params.segment);
  const file = getSegmentFile(access.media.id, name, profile);
  if (!file) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  touchJob(access.media.id, profile);
  const ct = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : 'application/octet-stream';
  pipeSegmentFile(file, ct, res, 'private, max-age=3600');
});

export function runInitialScan(): void {
  try {
    scanLibrary();
  } catch (e) {
    console.error('Initial scan failed:', e);
  }
  if (process.env.ENABLE_WATCH !== '0') {
    startFileWatch();
  }
}
