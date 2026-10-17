import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { getDb, closeDb } from './db/schema';
import { activeBackend } from './db/sqlite';
import { apiRouter, runInitialScan } from './routes/api';
import { getSessionUser } from './auth/session';
import { startCacheCleaner, stopAllTranscodeJobs } from './transcode/hls';

/**
 * Reverse proxy support: DSM Reverse Proxy, Cloudflare Tunnel, Tailscale and
 * nginx forward `X-Forwarded-For/Proto/Host`. Only proxies matching
 * TRUST_PROXY_HOPS are trusted (default: loopback, link-local and private
 * addresses — never "everyone"), so req.ip / req.secure / req.hostname are the
 * real values and an Internet client cannot spoof them. See config.ts.
 */
export const TRUST_PROXY = config.TRUST_PROXY;

/**
 * Content-Security-Policy compatible with the app: every script is a local
 * file (no inline script; hls.js is vendored), hls.js may use blob: workers
 * and MediaSource blob: URLs, posters/QR come from the same origin. Inline
 * `style="…"` attributes are still used by the UI, hence 'unsafe-inline' for
 * styles only. The app must never be framed (clickjacking).
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:', 'data:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** App version (package.json), used to version the PWA service-worker cache. */
export const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(pkg.version || 'dev');
  } catch {
    return 'dev';
  }
})();

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        // No upgrade-insecure-requests: the app is legitimately used over plain HTTP on the LAN.
        directives: CSP_DIRECTIVES,
      },
      // HSTS is only sent on HTTPS requests (below); never on the LAN http:// URL.
      strictTransportSecurity: false,
      // Media / posters may be loaded by VLC, Chromecast-like clients and the Android app.
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      xFrameOptions: { action: 'deny' },
    })
  );
  app.use((req, res, next) => {
    if (req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
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

  // --- PWA -------------------------------------------------------------------
  // The service worker is served at the root so it controls the whole origin.
  // Its cache name embeds the app version, so each release refreshes the shell.
  app.get('/sw.js', (_req, res) => {
    let source: string;
    try {
      source = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    } catch {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.send(source.replace(/__APP_VERSION__/g, APP_VERSION));
  });

  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

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
