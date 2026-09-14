import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { getDb } from './db/schema';
import { apiRouter, runInitialScan } from './routes/api';
import { getSessionUser } from './auth/session';
import { startCacheCleaner } from './transcode/hls';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'nas-simple-media' });
});

app.use('/api', apiRouter);

app.get('/s/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  if (!getSessionUser(req.cookies?.[config.COOKIE_NAME])) {
    res.redirect('/login.html');
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

getDb();
runInitialScan();
startCacheCleaner();

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`nas-simple-media listening on http://0.0.0.0:${config.PORT}`);
  console.log(`MEDIA_PATH=${config.MEDIA_PATH}`);
  console.log(`DATA_PATH=${config.DATA_PATH}`);
  console.log(`TRANSCODE_ENABLED=${config.TRANSCODE_ENABLED} FFMPEG=${config.FFMPEG_PATH} maxJobs=${config.TRANSCODE_MAX_JOBS}`);
  console.log(`Default admin user: admin / (ADMIN_PASSWORD)`);
});
