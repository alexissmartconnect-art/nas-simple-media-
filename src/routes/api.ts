import { Router, type Response } from 'express';
import { config } from '../config';
import { getDb, type MediaItem } from '../db/schema';
import { createSession, destroySession, getSessionUser } from '../auth/session';
import { requireAuth, requireAdmin, type AuthedRequest } from '../middleware/auth';
import { scanLibrary, startFileWatch } from '../scanner/scan';
import {
  createShare,
  listShares,
  revokeShare,
  resolveShare,
  incrementShareUse,
  assertCanShareMedia,
} from '../shares/shares';
import { streamFile, isPathAllowed } from './stream';
import { authenticate, listUsers, createUser, updateUser, setUserLibraries, getUserLibraryIds } from '../users/users';
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
} from '../auth/streamTokens';
import { getPlaybackHint } from '../transcode/formats';
import {
  ensureTranscode,
  getJobStatus,
  getSegmentFile,
  readPlaylist,
  isTranscodeEnabled,
  touchJob,
} from '../transcode/hls';
import fs from 'fs';
import path from 'path';

export const apiRouter = Router();

function okUser(req: AuthedRequest) {
  return req.user;
}

apiRouter.post('/login', (req, res) => {
  const username = String(req.body?.username || 'admin');
  const password = String(req.body?.password || '');
  const user = authenticate(username, password);
  if (!user) {
    res.status(401).json({ error: 'Identifiants incorrects' });
    return;
  }
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
  const offset = parseInt(String(req.query.offset || '0'), 10) || 0;

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
  const items = db
    .prepare(
      `SELECT * FROM media_items ${whereSql}
       ORDER BY
         CASE kind WHEN 'series' THEN show_name WHEN 'music' THEN artist ELSE title END,
         season, episode, track_num, title
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as MediaItem[];

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM media_items ${whereSql}`).get(...params) as { c: number }
  ).c;

  res.json({ items, total, limit, offset });
});

apiRouter.get('/media/:id', requireAuth, (req, res) => {
  const user = okUser(req as AuthedRequest);
  const item = getDb()
    .prepare('SELECT * FROM media_items WHERE id = ?')
    .get(Number(req.params.id)) as MediaItem | undefined;
  if (!item || !userCanAccessLibrary(user, item.library_id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const playback = getPlaybackHint(item.filename || item.path, item.type);
  res.json({
    ...item,
    playback,
    transcodeEnabled: isTranscodeEnabled(),
  });
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
  req: import('express').Request,
  res: import('express').Response,
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
  const streamUrl = buildRawStreamUrl(item.id, token);
  const m3uUrl = `${config.PUBLIC_BASE_URL}/api/media/${item.id}/playlist.m3u?token=${encodeURIComponent(token)}`;
  res.json({
    streamUrl,
    m3uUrl,
    vlcUri: `vlc://${streamUrl.replace(/^https?:\/\//, '')}`,
    help:
      'Dans VLC : Média → Ouvrir un flux réseau → collez streamUrl. Ou en CLI : vlc "<streamUrl>". ' +
      'Le fichier .m3u ouvre directement le flux authentifié. VLC lit DTS/AC3 5.1 ; le mode Compatible navigateur downmixe en AAC stéréo.',
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
  const streamUrl = buildRawStreamUrl(item.id, token);
  const body = buildM3uContent(item.title, streamUrl);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent((item.title || 'media').replace(/[^\w.\- ]+/g, '_') + '.m3u')}`
  );
  res.send(body);
});

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
  const st = ensureTranscode(mediaId, item.path);
  const qToken = typeof req.query.token === 'string' ? req.query.token : '';
  const tokenQs = qToken ? `?token=${encodeURIComponent(qToken)}` : '';
  res.json({
    ...st,
    playlistUrl: `/api/stream/${mediaId}/hls/playlist.m3u8${tokenQs}`,
    note: 'Compatible = H.264 + AAC stéréo (downmix). Pas de passthrough DTS dans le navigateur.',
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
  ensureTranscode(mediaId, item.path);
  const body = readPlaylist(mediaId);
  if (!body) {
    res.status(202).json({
      error: 'Transcodage en cours',
      status: getJobStatus(mediaId).status,
      retryAfterMs: 1500,
    });
    return;
  }
  touchJob(mediaId);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
});

apiRouter.get('/stream/:id/hls/:segment', (req, res) => {
  const mediaId = Number(req.params.id);
  const item = authStreamOrToken(req, res, mediaId, 'hls');
  if (!item) return;
  const name = path.basename(req.params.segment);
  const file = getSegmentFile(mediaId, name);
  if (!file) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  touchJob(mediaId);
  const ct = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(file).pipe(res);
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
    publicBaseUrl: config.PUBLIC_BASE_URL,
    counts,
    lastScan: last?.value || null,
    user,
    transcode: {
      enabled: isTranscodeEnabled(),
      maxJobs: config.TRANSCODE_MAX_JOBS,
      ffmpegPath: config.FFMPEG_PATH,
    },
  });
});

// ---- Shares ----
apiRouter.get('/shares', requireAuth, (req, res) => {
  res.json({ shares: listShares(okUser(req as AuthedRequest)) });
});

apiRouter.post('/shares', requireAuth, (req, res) => {
  try {
    const user = okUser(req as AuthedRequest);
    const mediaId = Number(req.body?.mediaId);
    if (!mediaId) {
      res.status(400).json({ error: 'mediaId required' });
      return;
    }
    assertCanShareMedia(user, mediaId);
    const share = createShare({
      mediaId,
      expiresAt: req.body?.expiresAt || null,
      maxUses: req.body?.maxUses != null ? Number(req.body.maxUses) : null,
      password: req.body?.password || null,
      createdBy: user.id,
    });
    res.status(201).json(share);
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

// ---- Public share ----
apiRouter.get('/public/share/:token', (req, res) => {
  const password = (req.query.password as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.json({ needsPassword: true, title: access.media.title, type: access.media.type });
    return;
  }
  const playback = getPlaybackHint(access.media.filename || access.media.path, access.media.type);
  res.json({
    needsPassword: false,
    id: access.media.id,
    title: access.media.title,
    type: access.media.type,
    kind: access.media.kind,
    artist: access.media.artist,
    album: access.media.album,
    show_name: access.media.show_name,
    season: access.media.season,
    episode: access.media.episode,
    filename: access.media.filename,
    playback,
    transcodeEnabled: isTranscodeEnabled(),
  });
});

apiRouter.get('/public/stream/:token', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  incrementShareUse(req.params.token);
  streamFile(access.media.path, req, res);
});

/** Alias for VLC: same as public stream (original + Range). */
apiRouter.get('/public/stream/:token/raw', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  streamFile(access.media.path, req, res);
});

apiRouter.get('/public/download/:token', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!isPathAllowed(access.media.path)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  streamFile(access.media.path, req, res, {
    download: true,
    filename: access.media.filename,
  });
});

apiRouter.get('/public/vlc/:token', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  const streamUrl = buildShareRawStreamUrl(req.params.token, password);
  const m3uUrl =
    `${config.PUBLIC_BASE_URL}/api/public/playlist/${encodeURIComponent(req.params.token)}` +
    (password ? `?password=${encodeURIComponent(password)}` : '');
  res.json({
    streamUrl,
    m3uUrl,
    vlcUri: `vlc://${streamUrl.replace(/^https?:\/\//, '')}`,
    help:
      'VLC : Média → Ouvrir un flux réseau, ou téléchargez le .m3u. VLC lit le fichier original (DTS 5.1 inclus).',
  });
});

apiRouter.get('/public/playlist/:token', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  const streamUrl = buildShareRawStreamUrl(req.params.token, password);
  const body = buildM3uContent(access.media.title, streamUrl);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent((access.media.title || 'share').replace(/[^\w.\- ]+/g, '_') + '.m3u')}`
  );
  res.send(body);
});

apiRouter.get('/public/hls/:token', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
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
  const st = ensureTranscode(access.media.id, access.media.path);
  const pw = password ? `?password=${encodeURIComponent(password)}` : '';
  res.json({
    ...st,
    playlistUrl: `/api/public/hls/${encodeURIComponent(req.params.token)}/playlist.m3u8${pw}`,
  });
});

apiRouter.get('/public/hls/:token/playlist.m3u8', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  if (!isTranscodeEnabled()) {
    res.status(503).json({ error: 'Transcodage désactivé' });
    return;
  }
  ensureTranscode(access.media.id, access.media.path);
  let body = readPlaylist(access.media.id);
  if (!body) {
    res.status(202).json({
      error: 'Transcodage en cours',
      status: getJobStatus(access.media.id).status,
      retryAfterMs: 1500,
    });
    return;
  }
  if (password) {
    const q = `?password=${encodeURIComponent(password)}`;
    body = body
      .split('\n')
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        if (t.includes('?')) return line;
        return `${t}${q}`;
      })
      .join('\n');
  }
  touchJob(access.media.id);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
});

apiRouter.get('/public/hls/:token/:segment', (req, res) => {
  const password =
    (req.query.password as string) || (req.headers['x-share-password'] as string) || undefined;
  const access = resolveShare(req.params.token, password);
  if (!access.ok) {
    res.status(403).json({ error: access.reason });
    return;
  }
  if (access.needsPassword) {
    res.status(401).json({ error: 'Password required', needsPassword: true });
    return;
  }
  const name = path.basename(req.params.segment);
  const file = getSegmentFile(access.media.id, name);
  if (!file) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  touchJob(access.media.id);
  const ct = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(file).pipe(res);
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

// silence unused
void getLibrary;
void Response;
