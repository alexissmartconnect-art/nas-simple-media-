/* Public share page (external file: compatible with the strict CSP). */
const token = location.pathname.split('/').pop();
let accessToken = ''; // short-lived signed token from POST …/unlock (never the password)
let meta = null;
let items = [];
let filtered = [];
let current = null;
let queueIndex = -1;
let hls = null;
let playMode = 'direct';
let profile = { quality: 'original', audioIndex: 0, surround: false, passthrough: false };
let subIndex = -1;
let streamsCache = {};

const $ = (id) => document.getElementById(id);

function pwQs() {
  // The httpOnly cookie set by /unlock already authorizes same-origin requests;
  // the token is also put in URLs for players that do not send cookies.
  return accessToken ? ('?access=' + encodeURIComponent(accessToken)) : '';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function itemStream(id) {
  return '/api/public/share/' + encodeURIComponent(token) + '/item/' + id + '/stream' + pwQs();
}
function profileQs() {
  const parts = [];
  if (profile.quality !== 'original') parts.push('quality=' + profile.quality);
  if (profile.audioIndex) parts.push('audio=' + profile.audioIndex);
  if (profile.surround) parts.push('surround=1');
  if (profile.passthrough) parts.push('passthrough=1');
  return parts.join('&');
}
function itemHls(id) {
  const base = pwQs();
  const pq = profileQs();
  if (!pq) return '/api/public/share/' + encodeURIComponent(token) + '/item/' + id + '/hls' + base;
  return '/api/public/share/' + encodeURIComponent(token) + '/item/' + id + '/hls' + base + (base ? '&' : '?') + pq;
}
function itemSubUrl(id, idx) {
  const base = pwQs();
  return '/api/public/share/' + encodeURIComponent(token) + '/item/' + id + '/subtitles/' + idx + '.vtt' + base;
}
function applySubtitleTrack() {
  const video = $('video');
  video.querySelectorAll('track').forEach((t) => t.remove());
  if (!current || subIndex < 0) return;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.src = itemSubUrl(current.id, subIndex);
  track.default = true;
  const meta = ((streamsCache[current.id] || {}).subtitles || []).find((s) => s.index === subIndex);
  track.label = (meta && meta.label) || 'Sous-titres';
  if (meta && meta.language) track.srclang = meta.language;
  video.appendChild(track);
}
function populateSelectors(item, streams) {
  $('selQuality').value = profile.quality;
  const audios = (streams && streams.audio) || [];
  let ah = '';
  if (!audios.length) {
    ah = '<option value="0:stereo">Piste audio par défaut</option>';
  } else {
    audios.forEach((a, i) => {
      const label = a.label || ('Piste ' + (i + 1));
      ah += `<option value="${i}:stereo"${profile.audioIndex === i && !profile.surround && !profile.passthrough ? ' selected' : ''}>${escapeHtml(label)} — Stéréo</option>`;
      if (a.channels >= 6) {
        ah += `<option value="${i}:surround"${profile.audioIndex === i && profile.surround && !profile.passthrough ? ' selected' : ''}>${escapeHtml(label)} — Surround 5.1</option>`;
      }
      const lc = String(a.codec || '').toLowerCase();
      if (streams.passthroughAllowed && (lc === 'ac3' || lc === 'eac3')) {
        ah += `<option value="${i}:passthrough"${profile.audioIndex === i && profile.passthrough ? ' selected' : ''}>${escapeHtml(label)} — Original (Safari/TV)</option>`;
      }
    });
  }
  $('selAudio').innerHTML = ah;
  let sh = `<option value="-1"${subIndex < 0 ? ' selected' : ''}>Aucun</option>`;
  ((streams && streams.subtitles) || []).forEach((s) => {
    if (s.imageBased) {
      sh += `<option value="-1" disabled>${escapeHtml(s.label || 'Image')} — VLC uniquement</option>`;
    } else {
      sh += `<option value="${s.index}"${subIndex === s.index ? ' selected' : ''}>${escapeHtml(s.label || ('ST ' + s.index))}</option>`;
    }
  });
  $('selSubs').innerHTML = sh;
}
async function loadStreams(item) {
  if (streamsCache[item.id]) return streamsCache[item.id];
  try {
    const res = await fetch('/api/public/share/' + encodeURIComponent(token) + '/item/' + item.id + '/streams' + pwQs());
    if (res.ok) {
      const data = await res.json();
      streamsCache[item.id] = data;
      // Default to surround when available
      if (data.summary && data.summary.hasSurround) {
        const idx = (data.audio || []).findIndex((a) => a.channels >= 6);
        profile.audioIndex = idx >= 0 ? idx : 0;
        profile.surround = true;
      }
      const defSub = (data.subtitles || []).find((s) => s.isDefault && !s.imageBased);
      subIndex = defSub ? defSub.index : -1;
      return data;
    }
  } catch {}
  return null;
}
function destroyHls() {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
}
function setMode(mode) {
  playMode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

async function playDirect(item) {
  destroyHls();
  const stream = itemStream(item.id);
  const video = $('video');
  const audio = $('audio');
  if (item.type === 'track') {
    audio.classList.remove('hidden');
    video.classList.add('hidden');
    audio.src = stream;
    audio.play().catch(() => {});
  } else {
    video.classList.remove('hidden');
    audio.classList.add('hidden');
    applySubtitleTrack();
    video.src = stream;
    const onErr = () => {
      video.removeEventListener('error', onErr);
      if (item.transcodeEnabled !== false && meta.transcodeEnabled !== false) {
        $('playerHint').textContent = 'Direct impossible — bascule Compatible…';
        setMode('compatible');
        playCompatible(item);
      }
    };
    video.addEventListener('error', onErr);
    video.play().catch(() => {});
  }
}

async function playCompatible(item) {
  destroyHls();
  const video = $('video');
  const audio = $('audio');
  audio.classList.add('hidden');
  video.classList.remove('hidden');
  video.removeAttribute('src');
  applySubtitleTrack();
  $('playerHint').textContent = 'Transcodage Compatible (HLS)…';
  $('decisionBadge').classList.add('hidden');
  const res = await fetch(itemHls(item.id));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('playerHint').textContent = data.error || 'Compatible indisponible — utilisez VLC.';
    return;
  }
  if (data.decision) {
    const badge = $('decisionBadge');
    badge.textContent = '⚙ ' + (data.decision.modeLabel || data.decision.mode);
    badge.title = data.decision.reason || '';
    badge.classList.remove('hidden');
    $('playerHint').textContent = data.decision.reason || '';
  }
  const playlistUrl = data.playlistUrl;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(playlistUrl, { credentials: 'same-origin' });
    if (r.ok) {
      const t = await r.clone().text();
      if (t.includes('#EXTM3U') && t.includes('#EXTINF:')) break;
    }
    await new Promise((x) => setTimeout(x, 1200));
    if (i === 39) {
      $('playerHint').textContent = 'Transcodage trop long — préférez VLC.';
      return;
    }
  }
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(playlistUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlistUrl;
    video.play().catch(() => {});
  } else {
    $('playerHint').textContent = 'HLS non supporté — utilisez VLC.';
  }
}

async function playItem(item) {
  current = item;
  queueIndex = filtered.findIndex((x) => x.id === item.id);
  profile = { quality: 'original', audioIndex: 0, surround: false, passthrough: false };
  subIndex = -1;
  $('playerBox').classList.remove('hidden');
  $('nowTitle').textContent = item.title;
  const bits = [];
  if (item.show_name) bits.push(item.show_name + (item.season != null ? ` S${String(item.season).padStart(2,'0')}E${String(item.episode).padStart(2,'0')}` : ''));
  if (item.artist) bits.push(item.artist + (item.album ? ' — ' + item.album : ''));
  bits.push(item.type);
  $('nowMeta').textContent = bits.join(' · ');
  $('btnDownload').href = '/api/public/share/' + encodeURIComponent(token) + '/item/' + item.id + '/download' + pwQs();
  $('btnM3u').href = '/api/public/share/' + encodeURIComponent(token) + '/item/' + item.id + '/playlist.m3u' + pwQs();
  $('modeToggle').classList.toggle('hidden', item.type === 'track');
  $('profileRow').classList.toggle('hidden', item.type === 'track');
  let streams = null;
  if (item.type !== 'track') {
    streams = await loadStreams(item);
    populateSelectors(item, streamsCache[item.id] || streams);
  }
  const summaryBits = [];
  if (streams && streams.summary) {
    if (streams.summary.videoLabel) summaryBits.push(streams.summary.videoLabel);
    (streams.summary.audioLabels || []).slice(0, 2).forEach((a) => summaryBits.push(a));
  }
  $('playerHint').textContent =
    (item.playback && item.playback.reason ? item.playback.reason + ' — ' : '') +
    (summaryBits.length ? summaryBits.join(' · ') + ' — ' : '') +
    'Direct = original. Compatible = HLS (Stéréo ou Surround 5.1). VLC = bitstream original.';
  const mode = (item.type !== 'track' && item.playback && item.playback.suggestedMode === 'compatible' && meta.transcodeEnabled !== false)
    ? 'compatible' : 'direct';
  setMode(mode);
  if (mode === 'compatible') playCompatible(item);
  else playDirect(item);
  renderList();
}

function playNext() {
  if (queueIndex >= 0 && queueIndex < filtered.length - 1) playItem(filtered[queueIndex + 1]);
}
function playPrev() {
  if (queueIndex > 0) playItem(filtered[queueIndex - 1]);
}

function groupHtml(list) {
  if (!list.length) return '<div class="empty">Aucun média.</div>';
  const isSeries = list.some((i) => i.type === 'episode');
  const isMusic = list.some((i) => i.type === 'track');
  if (isSeries) {
    const groups = new Map();
    for (const it of list) {
      const s = it.season != null ? Number(it.season) : 1;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(it);
    }
    let html = '';
    for (const [season, eps] of groups.entries()) {
      html += `<div class="group-header"><span>Saison ${season}</span><span class="muted">${eps.length} ép.</span></div>`;
      html += listRows(eps);
    }
    return html;
  }
  if (isMusic) {
    const groups = new Map();
    for (const it of list) {
      const alb = it.album || 'Album inconnu';
      if (!groups.has(alb)) groups.set(alb, []);
      groups.get(alb).push(it);
    }
    let html = '';
    for (const [album, tracks] of groups.entries()) {
      html += `<div class="group-header"><span>💿 ${escapeHtml(album)}</span><span class="muted">${tracks.length} piste(s)</span></div>`;
      html += listRows(tracks);
    }
    return html;
  }
  return listRows(list);
}

function listRows(list) {
  return `<div class="list">${list.map((it) => {
    const playing = current && current.id === it.id ? ' playing' : '';
    const extra = it.type === 'episode'
      ? `S${String(it.season ?? 1).padStart(2,'0')}E${String(it.episode ?? 1).padStart(2,'0')}`
      : (it.artist || it.type || '');
    return `<div class="list-item${playing}" data-id="${it.id}">
      <div class="left">
        <div class="title">${escapeHtml(it.title)}</div>
        <div class="meta">${escapeHtml(extra)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-play" type="button">Lire</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderList() {
  $('itemList').innerHTML = groupHtml(filtered);
  $('itemList').querySelectorAll('.list-item').forEach((row) => {
    const id = Number(row.getAttribute('data-id'));
    row.querySelector('.btn-play').addEventListener('click', () => {
      const it = filtered.find((x) => x.id === id);
      if (it) playItem(it);
    });
  });
}

function applyFilter() {
  const q = ($('shareSearch').value || '').trim().toLowerCase();
  filtered = !q
    ? items.slice()
    : items.filter((it) =>
        [it.title, it.show_name, it.artist, it.album, it.filename]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q))
      );
  renderList();
}

async function load() {
  const url = '/api/public/share/' + encodeURIComponent(token) + pwQs();
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('pwdBox').classList.add('hidden');
    $('portalBox').classList.add('hidden');
    const box = $('errBox');
    box.textContent = data.error || 'Accès refusé';
    box.classList.remove('hidden');
    return;
  }
  if (data.needsPassword) {
    $('pwdBox').classList.remove('hidden');
    $('portalBox').classList.add('hidden');
    return;
  }
  meta = data;
  items = data.items && data.items.length ? data.items : [data];
  items.forEach((it) => { it.transcodeEnabled = data.transcodeEnabled; });
  filtered = items.slice();
  $('pwdBox').classList.add('hidden');
  $('errBox').classList.add('hidden');
  $('portalBox').classList.remove('hidden');
  $('title').textContent = data.shareTitle || data.title || 'Partage';
  const bits = [];
  if (data.targetType) bits.push(data.targetType);
  bits.push((data.itemCount || items.length) + ' média(s)');
  $('meta').textContent = bits.join(' · ');
  $('btnPlaylist').href = '/api/public/playlist/' + encodeURIComponent(token) + pwQs();
  applyFilter();
  if (items.length === 1) playItem(items[0]);
}

$('pwdBox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwdErr = $('pwdErr');
  pwdErr.classList.add('hidden');
  const res = await fetch('/api/public/share/' + encodeURIComponent(token) + '/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('sharePwd').value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    pwdErr.textContent = data.error || 'Mot de passe incorrect';
    pwdErr.classList.remove('hidden');
    return;
  }
  accessToken = data.accessToken || '';
  $('sharePwd').value = '';
  load();
});
$('shareSearch').addEventListener('input', applyFilter);
$('btnPlayAll').addEventListener('click', () => {
  if (filtered.length) playItem(filtered[0]);
});
$('btnQr').addEventListener('click', () => {
  const url = meta.shareUrl || location.href;
  $('qrUrl').value = url;
  $('qrImg').src = meta.qrUrl || ('/api/qr?text=' + encodeURIComponent(url));
  $('qrModal').classList.remove('hidden');
});
$('qrClose').addEventListener('click', () => $('qrModal').classList.add('hidden'));
$('qrCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('qrUrl').value); } catch {}
});
$('btnModeDirect').addEventListener('click', () => { if (current) { setMode('direct'); playDirect(current); } });
$('btnModeCompat').addEventListener('click', () => { if (current && current.type !== 'track') { setMode('compatible'); playCompatible(current); } });
$('selQuality').addEventListener('change', (e) => {
  profile.quality = e.target.value;
  if (current && playMode === 'compatible') playCompatible(current);
});
$('selAudio').addEventListener('change', (e) => {
  const m = /^(\d+):(stereo|surround|passthrough)$/.exec(e.target.value || '');
  profile.audioIndex = m ? Number(m[1]) : 0;
  profile.surround = !!m && m[2] === 'surround';
  profile.passthrough = !!m && m[2] === 'passthrough';
  if (current && playMode === 'compatible') playCompatible(current);
});
$('selSubs').addEventListener('change', (e) => {
  subIndex = Number(e.target.value);
  applySubtitleTrack();
});
$('btnPrev').addEventListener('click', playPrev);
$('btnNext').addEventListener('click', playNext);
$('video').addEventListener('ended', playNext);
$('audio').addEventListener('ended', playNext);
$('btnVlc').addEventListener('click', async () => {
  if (!current) return;
  const res = await fetch('/api/public/share/' + encodeURIComponent(token) + '/item/' + current.id + '/vlc' + pwQs());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Erreur'); return; }
  $('vlcUrl').value = data.streamUrl;
  $('vlcM3uLink').href = data.m3uUrl;
  $('vlcQrImg').src = data.qrUrl || ('/api/qr?text=' + encodeURIComponent(data.streamUrl));
  $('vlcCopied').classList.add('hidden');
  $('vlcModal').classList.remove('hidden');
  try {
    await navigator.clipboard.writeText(data.streamUrl);
    $('vlcCopied').classList.remove('hidden');
  } catch {}
});
$('vlcClose').addEventListener('click', () => $('vlcModal').classList.add('hidden'));
$('vlcCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('vlcUrl').value);
    $('vlcCopied').classList.remove('hidden');
  } catch {}
});
load();
