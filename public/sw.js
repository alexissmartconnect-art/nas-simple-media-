/* NAS Simple Media — service worker (PWA)
 *
 * Règles de cache, volontairement strictes :
 *  - Coquille statique (CSS, JS, icônes, hls.js vendorisé, manifeste, page hors
 *    ligne) : cache d'abord, rafraîchie en arrière-plan.
 *  - Pages HTML (/, /login.html, /s/<jeton>) : toujours le réseau ; la page
 *    « hors ligne » n'est servie qu'en cas d'échec réseau. Elles ne sont jamais
 *    mises en cache (elles dépendent de la session ou d'un jeton de partage).
 *  - Tout le reste — /api/*, flux, playlists/segments HLS, téléchargements,
 *    /s/*, URL avec paramètres (jetons), requêtes Range, autres origines — passe
 *    directement par le réseau et n'est JAMAIS mis en cache.
 *
 * __APP_VERSION__ est remplacé par le serveur (version de package.json) : chaque
 * nouvelle version crée un nouveau cache et l'activation supprime les anciens.
 */
'use strict';

const VERSION = '__APP_VERSION__';
const CACHE = 'nasm-shell-' + VERSION;
const OFFLINE_URL = '/offline.html';

const SHELL = [
  '/css/style.css',
  '/js/app.js',
  '/js/pwa.js',
  '/js/offline.js',
  '/vendor/hls.js/hls.min.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  OFFLINE_URL,
];

const STATIC_PREFIXES = ['/css/', '/js/', '/vendor/', '/icons/'];
const STATIC_FILES = new Set(['/manifest.webmanifest', OFFLINE_URL]);

function isStaticAsset(url) {
  if (url.search) return false; // jamais d'URL avec paramètres (jetons, etc.)
  if (STATIC_FILES.has(url.pathname)) return true;
  return STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('nasm-') && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const res = await refresh;
  return res || Response.error();
}

async function networkWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return; // médias : jamais via le SW

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API, flux, HLS, partages : réseau uniquement, sans intervention.
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkWithOfflineFallback(req));
    return;
  }

  if (url.pathname.startsWith('/s/')) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req));
  }
  // Tout le reste : comportement réseau par défaut du navigateur.
});
