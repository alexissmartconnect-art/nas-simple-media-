import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { getDb, closeDb } from './db/schema';
import { activeBackend } from './db/sqlite';
import { apiRouter, runInitialScan } from './routes/api';
import { getSessionUser } from './auth/session';
import { startCacheCleaner, stopAllTranscodeJobs } from './transcode/hls';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nas-simple-media' });
  });

  app.use('/api', apiRouter);

  const publicDir = path.join(__dirname, '..', 'public');

  app.get('/s/:token', (_req, res) => {
    res.sendFile(path.join(publicDir, 'share.html'));
  });

  app.get(['/', '/index.html'], (req, res) => {
    if (!getSessionUser(req.cookies?.[config.COOKIE_NAME])) {
      res.redirect('/login.html');
      return;
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(express.static(publicDir, { index: false }));

  return app;
}

if (require.main === module) {
  getDb();
  runInitialScan();
  startCacheCleaner();

  const app = createApp();
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`nas-simple-media listening on http://0.0.0.0:${config.PORT}`);
    console.log(`MEDIA_PATH=${config.MEDIA_PATH}`);
    console.log(`DATA_PATH=${config.DATA_PATH}`);
    console.log(
      `TRANSCODE_ENABLED=${config.TRANSCODE_ENABLED} FFMPEG=${config.FFMPEG_PATH} maxJobs=${config.TRANSCODE_MAX_JOBS}`
    );
    console.log(`SQLite backend: ${activeBackend()}`);
    console.log(`Default admin user: admin / (ADMIN_PASSWORD)`);
  });

  const shutdown = () => {
    stopAllTranscodeJobs();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
