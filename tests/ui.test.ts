import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const REPO_ROOT = path.resolve(__dirname, '..');
const MEDIA_ROOT = '/volume1';
const PRIVATE_SHARE_URL = 'http://192.168.1.42:8096/s/tok123';

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => null },
  };
}

const wait = async (win: any, ticks = 20) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 25));
  return win;
};

interface UiOptions {
  /** Number of indexed media: 0 triggers the first-run assistant. */
  mediaCount?: number;
}

/**
 * Boot the real `public/index.html` + `public/js/app.js` in jsdom with a stubbed
 * HTTP API, so the 1.5.0 UI flows can be asserted without a browser.
 */
async function bootUi(options: UiOptions = {}) {
  const mediaCount = options.mediaCount ?? 5;
  const html = fs
    .readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8')
    // hls.js (vendored) is not loaded in tests: the video player is not exercised here
    .replace(/<script src="\/vendor\/hls\.js\/[^"]*"><\/script>/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://nas.local:8096/' });
  const win: any = dom.window;
  win.alert = () => {};
  try {
    win.navigator.clipboard = { writeText: async () => {} };
  } catch {}

  const calls: string[] = [];
  const library = {
    id: 1,
    name: 'Films maison',
    type: 'movies',
    path: 'Films',
    enabled: true,
    item_count: mediaCount,
    resolved_path: `${MEDIA_ROOT}/Films`,
    created_at: '',
    updated_at: '',
  };
  const fsState = {
    path: MEDIA_ROOT,
    parent: '/',
    roots: [
      { path: MEDIA_ROOT, label: 'MEDIA_PATH (/volume1)', kind: 'media', readable: true, exists: true, mediaCount },
      { path: '/volumeUSB1/usbshare1', label: 'volumeUSB1/usbshare1', kind: 'usb', readable: true, exists: true, mediaCount: 4 },
    ],
    dirs: [
      { name: 'Films', path: `${MEDIA_ROOT}/Films`, mediaCount: 5, isSymlink: false },
      { name: 'Musique', path: `${MEDIA_ROOT}/Musique`, mediaCount: 2, isSymlink: false },
    ],
    mediaCount,
    dirCount: 5,
    readable: true,
    error: null,
    hint: null,
  };

  win.fetch = async (resource: string, opts: any = {}) => {
    const url = String(resource);
    calls.push(`${opts.method || 'GET'} ${url}`);
    const body = opts.body ? JSON.parse(opts.body) : {};

    if (url === '/api/me') {
      return jsonResponse({
        authenticated: true,
        user: { id: 1, username: 'admin', role: 'admin', can_share: true },
      });
    }
    if (url === '/api/status') {
      return jsonResponse({
        mediaPath: MEDIA_ROOT,
        publicBaseUrl: 'http://192.168.1.42:8096',
        counts: mediaCount
          ? [{ library_id: 1, name: 'Films maison', type: 'movies', count: mediaCount }]
          : [{ library_id: 1, name: 'Films maison', type: 'movies', count: 0 }],
        lastScan: null,
        user: { id: 1, username: 'admin', role: 'admin' },
        transcode: { enabled: true },
      });
    }
    if (url === '/api/libraries') return jsonResponse({ libraries: [library] });
    if (url.startsWith('/api/continue-watching') || url.startsWith('/api/recently-added')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith('/api/admin/fs')) {
      const q = url.split('?path=')[1];
      const requested = q ? decodeURIComponent(q) : MEDIA_ROOT;
      return jsonResponse({
        ...fsState,
        path: requested,
        parent: requested === MEDIA_ROOT ? '/' : MEDIA_ROOT,
      });
    }
    if (url === '/api/admin/network/tailscale') {
      return jsonResponse({
        readOnly: true, serviceUser: 'sc-nas-simple-media', publicUrl: null,
        checks: [{ label: 'Configuration Funnel', status: 'warning', message: '<script>untrusted</script> Serve reste privé.' }],
        notice: 'Aucune modification.',
      });
    }
    if (url === '/api/admin/network/public-ip') {
      return jsonResponse({
        publicIp: '82.64.10.20',
        suggestedUrls: ['http://82.64.10.20:8096'],
        port: 8096,
        hint: '',
      });
    }
    if (url === '/api/admin/network') {
      return jsonResponse({
        port: 8096,
        hostname: 'diskstation',
        platform: 'linux',
        localUrl: 'http://192.168.1.42:8096',
        localUrls: [{ iface: 'eth0', address: '192.168.1.42', url: 'http://192.168.1.42:8096' }],
        savedPublicBaseUrl: null,
        envPublicBaseUrl: 'http://localhost:8096',
        effectiveBaseUrl: 'http://192.168.1.42:8096',
        requestOrigin: 'http://192.168.1.42:8096',
        requestHost: 'nas.local:8096',
        requestProtocol: 'http',
        forwardedProto: null,
        forwardedHost: null,
        behindReverseProxy: false,
        publicUrlIsPrivate: true,
        publicUrlIsLoopback: false,
        mobileLoginUrl: 'http://192.168.1.42:8096/login.html',
        qrUrl: '/api/qr?text=x',
        shareUrlExample: 'http://192.168.1.42:8096/s/<jeton>',
        warnings: ['L’adresse utilisée (http://192.168.1.42:8096) est privée.'],
        guide: [
          {
            id: 'synology-ddns',
            title: 'Option 1 — Synology DDNS (*.synology.me) + Proxy inversé DSM',
            summary: 'HTTPS gratuit, port 8096 jamais exposé.',
            recommended: true,
            steps: ['DDNS', 'Proxy inversé', 'Certificat', 'Box'],
            result: 'Liens externes',
          },
          {
            id: 'port-forward',
            title: 'Option 2 — Ouverture de port Box (NAT/PAT port 8096)',
            summary: 'NAT/PAT',
            steps: ['a', 'b'],
            result: 'ok',
          },
          {
            id: 'tunnel',
            title: 'Option 3 — Sans ouvrir de port (Tailscale / Cloudflare Tunnel)',
            summary: 'sans port',
            steps: ['a', 'b'],
            result: 'ok',
          },
        ],
      });
    }
    if (url === '/api/admin/settings/public-url') {
      return jsonResponse({
        ok: true,
        publicBaseUrl: body.publicBaseUrl || 'http://192.168.1.42:8096',
        network: {},
      });
    }
    if (url === '/api/shares' && opts.method === 'POST') {
      assert.equal(body.targetType, 'library');
      return jsonResponse({ token: 'tok123', url: PRIVATE_SHARE_URL, qrUrl: '/api/qr?text=x' }, 201);
    }
    if (url === '/api/shares') {
      return jsonResponse({ shares: [], publicBaseUrl: 'http://192.168.1.42:8096' });
    }
    if (url.startsWith('/api/media/')) return jsonResponse({ title: 'Films maison' });
    if (url.startsWith('/api/media')) return jsonResponse({ items: [] });
    if (url === '/api/admin/libraries') return jsonResponse({ libraries: [library] });
    if (url === '/api/rescan') {
      return jsonResponse({ scanned: 5, added: 5, updated: 0, removed: 0, errors: [] });
    }
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };

  win.eval(fs.readFileSync(path.join(REPO_ROOT, 'public', 'js', 'app.js'), 'utf8'));
  await wait(win); // let the async init chain (me → status → libraries → render) settle
  return { dom, win, calls };
}

/** jsdom smoke tests for the 1.5.0 UI (explorer, external access, share warning). */
describe('Web UI 1.5.0 — explorer, accès externe & avertissement de partage', () => {
  let dom: JSDOM;
  let win: any;
  let calls: string[];

  before(async () => {
    ({ dom, win, calls } = await bootUi({ mediaCount: 5 }));
  });

  after(() => {
    try {
      dom.window.close();
    } catch {}
  });

  it('authenticates the admin and unhides the external access navigation', () => {
    assert.equal(win.document.getElementById('whoami').textContent, 'admin');
    const netBtn = win.document.querySelector('[data-view="admin-network"]');
    assert.ok(netBtn, 'the sidebar must expose the external access view');
    assert.equal(netBtn.closest('.admin-only').classList.contains('hidden'), false);
    assert.equal(win.document.getElementById('content').textContent.includes('Démarrage rapide'), false);
  });

  it('renders the external access panel with the 3-step French guide', async () => {
    win.document.querySelector('[data-view="admin-network"]').click();
    await wait(win);
    const html = win.document.getElementById('content').innerHTML;
    assert.ok(html.includes('Réseau local (LAN / Wi-Fi)'));
    assert.ok(html.includes('Adresse externe (Internet / 4G / 5G)'));
    assert.ok(html.includes('http://192.168.1.42:8096'));
    assert.ok(html.includes('Option 1 — Synology DDNS'));
    assert.ok(html.includes('Option 2 — Ouverture de port Box'));
    assert.ok(html.includes('Option 3 — Sans ouvrir de port'));
    assert.ok(html.includes('Guide pas-à-pas'));
    assert.ok(win.document.getElementById('netPublicUrl'));
    assert.ok(win.document.getElementById('netTest'));
    assert.match(win.document.getElementById('netPublicIpChip').textContent, /82\.64\.10\.20/);

    // "Tester / QR Code" opens the mobile QR code on the external address.
    win.document.getElementById('netTest').click();
    await wait(win);
    assert.equal(win.document.getElementById('qrModal').classList.contains('hidden'), false);
    assert.equal(win.document.getElementById('qrModalUrl').value, 'http://192.168.1.42:8096/login.html');
    win.document.getElementById('qrModalClose').click();
  });

  it('runs a read-only Tailscale diagnostic and escapes its output without saving a URL', async () => {
    const before = calls.length;
    const button = win.document.getElementById('netTailscaleCheck');
    assert.ok(button);
    button.click();
    assert.equal(button.disabled, true);
    await wait(win);
    assert.equal(button.disabled, false);
    const result = win.document.getElementById('netTailscaleResult');
    assert.match(result.textContent, /sc-nas-simple-media/);
    assert.match(result.textContent, /À vérifier/);
    assert.equal(result.querySelector('script'), null);
    assert.deepEqual(calls.slice(before), ['GET /api/admin/network/tailscale']);
  });

  it('opens the NAS/USB explorer in the library modal and selects a folder', async () => {
    win.document.querySelector('[data-view="admin-libs"]').click();
    await wait(win);
    win.document.getElementById('btnNewLib').click();
    await wait(win);

    assert.equal(win.document.getElementById('libModal').classList.contains('hidden'), false);
    assert.equal(win.document.getElementById('fsPath').value, MEDIA_ROOT);
    const roots = [...win.document.querySelectorAll('[data-fs-root]')].map((b: any) =>
      b.getAttribute('data-fs-root')
    );
    assert.ok(roots.includes('/volumeUSB1/usbshare1'), roots.join(','));

    const rows = [...win.document.querySelectorAll('[data-fs-dir]')];
    assert.equal(rows.length, 2);
    assert.match(win.document.getElementById('fsList').textContent, /5 médias/);

    // Clicking a folder browses into it AND fills the path field.
    rows[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(win);
    assert.equal(win.document.getElementById('lPath').value, `${MEDIA_ROOT}/Films`);
    assert.equal(win.document.getElementById('fsPath').value, `${MEDIA_ROOT}/Films`);
    assert.ok(calls.some((c) => c.includes('/api/admin/fs?path=')));

    // "⬆ Parent" walks back up, "✓ Utiliser ce dossier" keeps the field in sync.
    win.document.getElementById('fsUp').click();
    await wait(win);
    assert.equal(win.document.getElementById('fsPath').value, MEDIA_ROOT);
    win.document.getElementById('fsUse').click();
    assert.equal(win.document.getElementById('lPath').value, MEDIA_ROOT);
    win.document.getElementById('libCancel').click();
    assert.equal(win.document.getElementById('libModal').classList.contains('hidden'), true);
  });

  it('warns when a freshly created share link is still a private address', async () => {
    win.document.querySelector('[data-view="browse"]').click();
    await wait(win);
    const shareBtn = win.document.querySelector('.btn-lib-share');
    assert.ok(shareBtn, 'library cards must expose a share button');
    shareBtn.click();
    await wait(win);
    assert.equal(win.document.getElementById('shareModal').classList.contains('hidden'), false);
    assert.equal(win.document.getElementById('sharePrivateWarn').classList.contains('hidden'), true);

    win.document.getElementById('shareCreate').click();
    await wait(win);
    assert.equal(win.document.getElementById('sharePrivateWarn').classList.contains('hidden'), false);
    assert.match(win.document.getElementById('sharePrivateWarnText').textContent, /192\.168\.1\.42/);
    assert.equal(win.document.getElementById('shareQrBox').classList.contains('hidden'), false);
    assert.match(win.document.getElementById('shareUrlOut').value, /^http:\/\/192\.168\.1\.42:8096\/s\//);

    // The direct button jumps to the external access panel.
    win.document.getElementById('shareConfigureExternal').click();
    await wait(win);
    assert.equal(win.document.getElementById('shareModal').classList.contains('hidden'), true);
    assert.ok(win.document.getElementById('sectionTitle').textContent.includes('Accès externe'));
  });
});

/** First run: no media at all → guided quick-start assistant on the home page. */
describe('Web UI 1.5.0 — assistant de premier démarrage (0 média)', () => {
  let dom: JSDOM;
  let win: any;
  let calls: string[];

  before(async () => {
    ({ dom, win, calls } = await bootUi({ mediaCount: 0 }));
  });

  after(() => {
    try {
      dom.window.close();
    } catch {}
  });

  it('offers the three quick-start actions', () => {
    const html = win.document.getElementById('content').innerHTML;
    assert.match(html, /Démarrage rapide/);
    assert.match(html, /Choisir mes dossiers Films \/ Séries \/ Musique/);
    assert.match(html, /Scanner maintenant/);
    assert.match(html, /Configurer l’accès externe/);
    assert.equal(win.document.querySelectorAll('[data-qs]').length, 3);
  });

  it('routes the actions to the scanner, the explorer and the network panel', async () => {
    win.document.querySelector('[data-qs="folders"]').click();
    await wait(win);
    assert.equal(win.document.getElementById('libModal').classList.contains('hidden'), false);
    assert.ok(win.document.querySelector('[data-fs-dir]'));
    win.document.getElementById('libCancel').click();

    win.document.querySelector('[data-view="browse"]').click();
    await wait(win);
    win.document.querySelector('[data-qs="scan"]').click();
    await wait(win);
    assert.ok(calls.some((c) => c === 'POST /api/rescan'));

    win.document.querySelector('[data-view="browse"]').click();
    await wait(win);
    win.document.querySelector('[data-qs="network"]').click();
    await wait(win);
    assert.ok(win.document.getElementById('sectionTitle').textContent.includes('Accès externe'));
    assert.ok(win.document.getElementById('content').innerHTML.includes('Option 1 — Synology DDNS'));
  });
});
