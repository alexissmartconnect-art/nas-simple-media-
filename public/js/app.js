(() => {
  const state = {
    user: null,
    view: 'browse',
    libraries: [],
    library: null, // selected library object
    drill: null, // show name / artist
    currentItem: null,
    visibleItems: [], // items currently displayed on screen
    queue: [], // array of media ids in current play queue
    queueIndex: -1,
    playMode: 'direct', // direct | compatible
    hls: null,
    q: '',
    editUserId: null,
    editLibId: null,
    allLibsAdmin: [],
    browseMode: 'media',
    folderPath: '',
    publicBaseUrl: '',
  };

  const $ = (id) => document.getElementById(id);
  const content = $('content');
  const sectionTitle = $('sectionTitle');

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (res.status === 401) {
      location.href = '/login.html';
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function isAdmin() {
    return state.user && state.user.role === 'admin';
  }

  function canShare() {
    return isAdmin() || (state.user && state.user.can_share);
  }

  function fmtBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function extLabel(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || '');
    return m ? m[1].toUpperCase() : '';
  }

  function iconFor(typeOrKind) {
    if (typeOrKind === 'movie' || typeOrKind === 'movies') return '🎬';
    if (typeOrKind === 'episode' || typeOrKind === 'series') return '📺';
    return '🎵';
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function emptyMsg(msg) {
    return `<div class="empty">${escapeHtml(msg)}</div>`;
  }

  async function refreshStats() {
    try {
      const st = await api('/api/status');
      if (st.publicBaseUrl) state.publicBaseUrl = st.publicBaseUrl;
      $('stats').innerHTML = (st.counts || [])
        .map(
          (c) =>
            `<span class="chip">${escapeHtml(c.name)}: <strong style="color:var(--text)">${c.count}</strong></span>`
        )
        .concat(
          st.lastScan
            ? [`<span class="chip">Dernier scan: ${new Date(st.lastScan).toLocaleString()}</span>`]
            : []
        )
        .join('');
    } catch {}
  }

  function setView(view) {
    state.view = view;
    if (view === 'browse') {
      state.library = null;
      state.drill = null;
    }
    document.querySelectorAll('#nav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    $('searchRow').classList.toggle('hidden', view.startsWith('admin') || view === 'shares');
    render();
  }

  async function loadLibraries() {
    const data = await api('/api/libraries');
    state.libraries = data.libraries || [];
  }

  async function render() {
    content.innerHTML = '<p class="muted">Chargement…</p>';
    try {
      if (state.view === 'shares') {
        sectionTitle.textContent = 'Mes liens de partage';
        await renderShares();
        return;
      }
      if (state.view === 'admin-users') {
        sectionTitle.textContent = 'Administration — Comptes';
        await renderAdminUsers();
        return;
      }
      if (state.view === 'admin-libs') {
        sectionTitle.textContent = 'Administration — Bibliothèques';
        await renderAdminLibs();
        return;
      }
      await renderBrowse();
    } catch (e) {
      content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    }
  }

  async function renderBrowse() {
    if (!state.library) {
      await loadLibraries();
      if (!state.libraries.length) {
        sectionTitle.textContent = 'Bibliothèques';
        content.innerHTML = emptyMsg(
          isAdmin()
            ? 'Aucune bibliothèque. Créez-en une dans Admin · Bibliothèques, puis Rescan.'
            : 'Aucune bibliothèque partagée avec votre compte. Demandez à un admin.'
        );
        return;
      }

      if (state.q) {
        sectionTitle.textContent = `Recherche : « ${state.q} »`;
        const data = await api(`/api/media?q=${encodeURIComponent(state.q)}&limit=200`);
        state.visibleItems = data.items || [];
        content.innerHTML =
          crumb([
            [
              'Bibliothèques',
              () => {
                $('search').value = '';
                state.q = '';
                render();
              },
            ],
            [`Résultats (${state.visibleItems.length})`],
          ]) +
          (state.visibleItems.length
            ? listHtml(state.visibleItems, { showOrigin: true })
            : emptyMsg(`Aucun média trouvé pour « ${state.q} »`));
        bindListActions();
        return;
      }

      sectionTitle.textContent = 'Bibliothèques';
      state.visibleItems = [];
      content.innerHTML = `<div class="grid">${state.libraries
        .map(
          (l) => `<article class="card" data-lib="${l.id}">
          <div class="thumb">${iconFor(l.type)}</div>
          <div>
            <div class="title">${escapeHtml(l.name)}</div>
            <div class="meta">${escapeHtml(l.type)} · ${l.item_count} média(s)</div>
            ${
              canShare()
                ? `<div class="card-actions"><button class="btn btn-sm btn-lib-share" type="button">🔗 Partager</button></div>`
                : ''
            }
          </div>
        </article>`
        )
        .join('')}</div>`;
      content.querySelectorAll('[data-lib]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = Number(el.getAttribute('data-lib'));
          state.library = state.libraries.find((l) => l.id === id);
          state.drill = null;
          state.folderPath = '';
          render();
        });
      });
      content.querySelectorAll('.btn-lib-share').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const card = btn.closest('[data-lib]');
          const id = Number(card.getAttribute('data-lib'));
          const lib = state.libraries.find((l) => l.id === id);
          if (lib) openShareModal({ targetType: 'library', libraryId: lib.id, label: lib.name });
        });
      });
      return;
    }

    const lib = state.library;
    if (state.browseMode === 'folders') {
      await renderFolderBrowse(lib);
      return;
    }
    if (lib.type === 'movies') {
      sectionTitle.textContent = lib.name;
      const data = await api(
        `/api/media?library_id=${lib.id}&limit=500` + (state.q ? '&q=' + encodeURIComponent(state.q) : '')
      );
      state.visibleItems = data.items || [];
      content.innerHTML =
        crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
        viewToggleHtml() +
        cardsHtml(state.visibleItems);
      bindCards();
      bindViewToggle();
      return;
    }

    if (lib.type === 'series') {
      if (!state.drill) {
        sectionTitle.textContent = lib.name;
        const data = await api(`/api/series?library_id=${lib.id}`);
        let shows = data.shows || [];
        if (state.q) {
          const qq = state.q.toLowerCase();
          shows = shows.filter((s) => (s.name || '').toLowerCase().includes(qq));
        }
        state.visibleItems = [];
        content.innerHTML =
          crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
          viewToggleHtml() +
          (shows.length
            ? `<div class="grid">${shows
                .map(
                  (s) => `<article class="card" data-show="${escapeAttr(s.name)}">
                <div class="thumb">📺</div>
                <div>
                  <div class="title">${escapeHtml(s.name)}</div>
                  <div class="meta">${s.seasons} saison(s) · ${s.episodes} ép.</div>
                  ${
                    canShare()
                      ? `<div class="card-actions"><button class="btn btn-sm btn-show-share" type="button">🔗 Partager</button></div>`
                      : ''
                  }
                </div>
              </article>`
                )
                .join('')}</div>`
            : emptyMsg('Aucun épisode. Ajoutez des fichiers puis Rescan (admin).'));
        bindViewToggle();
        content.querySelectorAll('[data-show]').forEach((el) => {
          el.addEventListener('click', () => {
            state.drill = el.getAttribute('data-show');
            render();
          });
        });
        content.querySelectorAll('.btn-show-share').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.closest('[data-show]').getAttribute('data-show');
            openShareModal({
              targetType: 'series',
              libraryId: lib.id,
              showName: name,
              label: name,
            });
          });
        });
        return;
      }
      sectionTitle.textContent = state.drill;
      const data = await api(
        `/api/media?library_id=${lib.id}&show=${encodeURIComponent(state.drill)}&limit=500` +
          (state.q ? '&q=' + encodeURIComponent(state.q) : '')
      );
      state.visibleItems = data.items || [];
      content.innerHTML =
        crumb([
          ['Bibliothèques', () => { state.library = null; state.drill = null; render(); }],
          [lib.name, () => { state.drill = null; render(); }],
          [state.drill],
        ]) +
        viewToggleHtml() +
        groupedSeriesHtml(state.visibleItems);
      bindListActions();
      bindViewToggle();
      bindCollectionShare();
      return;
    }

    // music
    if (!state.drill) {
      sectionTitle.textContent = lib.name;
      const data = await api(`/api/artists?library_id=${lib.id}`);
      let artists = data.artists || [];
      if (state.q) {
        const qq = state.q.toLowerCase();
        artists = artists.filter((a) => (a.name || '').toLowerCase().includes(qq));
      }
      state.visibleItems = [];
      content.innerHTML =
        crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
        viewToggleHtml() +
        (artists.length
          ? `<div class="grid">${artists
              .map(
                (a) => `<article class="card" data-artist="${escapeAttr(a.name)}">
              <div class="thumb">🎵</div>
              <div>
                <div class="title">${escapeHtml(a.name)}</div>
                <div class="meta">${a.albums} album(s) · ${a.tracks} pistes</div>
                ${
                  canShare()
                    ? `<div class="card-actions"><button class="btn btn-sm btn-artist-share" type="button">🔗 Partager</button></div>`
                    : ''
                }
              </div>
            </article>`
              )
              .join('')}</div>`
          : emptyMsg('Aucune musique. Ajoutez des fichiers puis Rescan (admin).'));
      bindViewToggle();
      content.querySelectorAll('[data-artist]').forEach((el) => {
        el.addEventListener('click', () => {
          state.drill = el.getAttribute('data-artist');
          render();
        });
      });
      content.querySelectorAll('.btn-artist-share').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = btn.closest('[data-artist]').getAttribute('data-artist');
          openShareModal({
            targetType: 'artist',
            libraryId: lib.id,
            artist: name,
            label: name,
          });
        });
      });
      return;
    }
    sectionTitle.textContent = state.drill;
    const data = await api(
      `/api/media?library_id=${lib.id}&artist=${encodeURIComponent(state.drill)}&limit=500` +
        (state.q ? '&q=' + encodeURIComponent(state.q) : '')
    );
    state.visibleItems = data.items || [];
    content.innerHTML =
      crumb([
        ['Bibliothèques', () => { state.library = null; state.drill = null; render(); }],
        [lib.name, () => { state.drill = null; render(); }],
        [state.drill],
      ]) +
      viewToggleHtml() +
      groupedMusicHtml(state.visibleItems);
    bindListActions();
    bindViewToggle();
    bindCollectionShare();
  }

  function viewToggleHtml() {
    return `<div class="view-toggle mode-toggle">
      <button type="button" class="btn mode-btn ${state.browseMode !== 'folders' ? 'active' : ''}" data-browse="media">Vue Média</button>
      <button type="button" class="btn mode-btn ${state.browseMode === 'folders' ? 'active' : ''}" data-browse="folders">📁 Par Dossiers</button>
    </div>`;
  }

  function bindViewToggle() {
    content.querySelectorAll('[data-browse]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.browseMode = btn.getAttribute('data-browse') === 'folders' ? 'folders' : 'media';
        if (state.browseMode === 'media') state.folderPath = '';
        render();
      });
    });
  }

  async function renderFolderBrowse(lib) {
    sectionTitle.textContent = lib.name;
    const data = await api(
      `/api/folders?library_id=${lib.id}&path=${encodeURIComponent(state.folderPath || '')}`
    );
    const crumbs = [
      [
        'Bibliothèques',
        () => {
          state.library = null;
          state.folderPath = '';
          render();
        },
      ],
      [
        lib.name,
        () => {
          state.folderPath = '';
          render();
        },
      ],
    ];
    const segs = (state.folderPath || '').split('/').filter(Boolean);
    let acc = '';
    segs.forEach((seg, i) => {
      acc = acc ? acc + '/' + seg : seg;
      const pathAt = acc;
      if (i === segs.length - 1) crumbs.push([seg]);
      else
        crumbs.push([
          seg,
          () => {
            state.folderPath = pathAt;
            render();
          },
        ]);
    });
    const shareFolderBtn =
      canShare() && state.folderPath
        ? `<button class="btn" id="btnShareFolder" type="button">🔗 Partager ce dossier</button>`
        : canShare()
          ? `<button class="btn" id="btnShareFolder" type="button">🔗 Partager la bibliothèque</button>`
          : '';
    const folderCards = (data.subfolders || [])
      .map(
        (f) => `<article class="card" data-folder="${escapeAttr(f.path)}">
        <div class="thumb">📁</div>
        <div>
          <div class="title">${escapeHtml(f.name)}</div>
          <div class="meta">${f.item_count} média(s)</div>
          ${
            canShare()
              ? `<div class="card-actions"><button class="btn btn-sm btn-folder-share" type="button">🔗 Partager</button></div>`
              : ''
          }
        </div>
      </article>`
      )
      .join('');
    state.visibleItems = data.items || [];
    content.innerHTML =
      crumb(crumbs) +
      viewToggleHtml() +
      `<div class="toolbar">${shareFolderBtn}<span class="muted folder-count">${data.total_in_tree || 0} dans l’arbre</span></div>` +
      (folderCards ? `<div class="grid">${folderCards}</div>` : '') +
      (state.visibleItems.length ? cardsHtml(state.visibleItems) : !folderCards ? emptyMsg('Dossier vide.') : '');
    bindViewToggle();
    bindCards();
    content.querySelectorAll('[data-folder]').forEach((el) => {
      el.addEventListener('click', () => {
        state.folderPath = el.getAttribute('data-folder');
        render();
      });
    });
    content.querySelectorAll('.btn-folder-share').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btn.closest('[data-folder]').getAttribute('data-folder');
        const name = path.split('/').pop();
        openShareModal({
          targetType: 'folder',
          libraryId: lib.id,
          folderPath: path,
          label: name,
        });
      });
    });
    const btnShareFolder = $('btnShareFolder');
    if (btnShareFolder) {
      btnShareFolder.addEventListener('click', () => {
        if (state.folderPath) {
          openShareModal({
            targetType: 'folder',
            libraryId: lib.id,
            folderPath: state.folderPath,
            label: state.folderPath.split('/').pop(),
          });
        } else {
          openShareModal({ targetType: 'library', libraryId: lib.id, label: lib.name });
        }
      });
    }
  }

  function bindCollectionShare() {
    content.querySelectorAll('[data-share-season]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const season = Number(btn.getAttribute('data-share-season'));
        openShareModal({
          targetType: 'series',
          libraryId: state.library.id,
          showName: state.drill,
          season,
          label: `${state.drill} · S${String(season).padStart(2, '0')}`,
        });
      });
    });
    content.querySelectorAll('[data-share-album]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const album = btn.getAttribute('data-share-album');
        openShareModal({
          targetType: 'artist',
          libraryId: state.library.id,
          artist: state.drill,
          album,
          label: `${state.drill} — ${album}`,
        });
      });
    });
    const shareShow = $('btnShareShow');
    if (shareShow) {
      shareShow.addEventListener('click', () => {
        openShareModal({
          targetType: 'series',
          libraryId: state.library.id,
          showName: state.drill,
          label: state.drill,
        });
      });
    }
    const shareArtist = $('btnShareArtist');
    if (shareArtist) {
      shareArtist.addEventListener('click', () => {
        openShareModal({
          targetType: 'artist',
          libraryId: state.library.id,
          artist: state.drill,
          label: state.drill,
        });
      });
    }
  }

  function crumb(parts) {
    const html = parts
      .map((p, i) => {
        if (p[1]) {
          return `<button type="button" data-crumb="${i}">${escapeHtml(p[0])}</button>`;
        }
        return `<span>${escapeHtml(p[0])}</span>`;
      })
      .join(' <span class="muted">/</span> ');
    setTimeout(() => {
      content.querySelectorAll('[data-crumb]').forEach((btn) => {
        const i = Number(btn.getAttribute('data-crumb'));
        btn.addEventListener('click', parts[i][1]);
      });
    }, 0);
    return `<div class="breadcrumbs">${html}</div>`;
  }

  function cardsHtml(items) {
    if (!items.length) return emptyMsg('Aucun média dans cette bibliothèque.');
    return `<div class="grid">${items
      .map((it) => {
        const ext = extLabel(it.filename);
        const shareBtn = canShare()
          ? `<button class="btn btn-sm btn-card-share" type="button" title="Partager">Partager</button>`
          : '';
        return `<article class="card" data-id="${it.id}">
          <div class="thumb">
            ${iconFor(it.type)}
            ${ext ? `<span class="ext-badge">${escapeHtml(ext)}</span>` : ''}
          </div>
          <div>
            <div class="title">${escapeHtml(it.title)}</div>
            <div class="meta">${fmtBytes(it.size_bytes)}</div>
            <div class="card-actions">
              <button class="btn btn-sm btn-primary btn-card-play" type="button">Lire</button>
              <button class="btn btn-sm btn-card-vlc" type="button" title="Ouvrir dans VLC">VLC</button>
              <button class="btn btn-sm btn-card-dl" type="button" title="Télécharger">DL</button>
              ${shareBtn}
            </div>
          </div>
        </article>`;
      })
      .join('')}</div>`;
  }

  function bindCards() {
    content.querySelectorAll('.card[data-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-id'));
      el.addEventListener('click', () => startQueueFromItem(id));
      const play = el.querySelector('.btn-card-play');
      if (play) play.addEventListener('click', (e) => { e.stopPropagation(); startQueueFromItem(id); });
      const vlc = el.querySelector('.btn-card-vlc');
      if (vlc) vlc.addEventListener('click', (e) => { e.stopPropagation(); openVlcModal(id); });
      const dl = el.querySelector('.btn-card-dl');
      if (dl) dl.addEventListener('click', (e) => { e.stopPropagation(); downloadMedia(id); });
      const sh = el.querySelector('.btn-card-share');
      if (sh) sh.addEventListener('click', (e) => { e.stopPropagation(); openShareModal(id); });
    });
  }

  function groupedSeriesHtml(items) {
    if (!items.length) return emptyMsg('Aucun épisode.');
    const groups = new Map();
    for (const it of items) {
      const s = it.season != null ? Number(it.season) : 1;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(it);
    }
    const playAllBtn =
      items.length > 1
        ? `<div class="toolbar"><button class="btn btn-primary" id="btnPlayAll" type="button">▶ Tout lire (${items.length} épisodes)</button>${
            canShare()
              ? `<button class="btn" id="btnShareShow" type="button">🔗 Partager</button>`
              : ''
          }</div>`
        : canShare()
          ? `<div class="toolbar"><button class="btn" id="btnShareShow" type="button">🔗 Partager</button></div>`
          : '';
    let html = playAllBtn;
    for (const [season, eps] of groups.entries()) {
      const shareSeason = canShare()
        ? `<button class="btn btn-sm" type="button" data-share-season="${season}">🔗 Partager</button>`
        : '';
      html += `<div class="group-header"><span>Saison ${season}</span><span class="muted">${eps.length} ép. ${shareSeason}</span></div>`;
      html += listHtml(eps);
    }
    return html;
  }

  function groupedMusicHtml(items) {
    if (!items.length) return emptyMsg('Aucune piste.');
    const groups = new Map();
    for (const it of items) {
      const alb = it.album || 'Album inconnu';
      if (!groups.has(alb)) groups.set(alb, []);
      groups.get(alb).push(it);
    }
    const playAllBtn =
      items.length > 1
        ? `<div class="toolbar"><button class="btn btn-primary" id="btnPlayAll" type="button">▶ Tout lire (${items.length} pistes)</button>${
            canShare()
              ? `<button class="btn" id="btnShareArtist" type="button">🔗 Partager</button>`
              : ''
          }</div>`
        : canShare()
          ? `<div class="toolbar"><button class="btn" id="btnShareArtist" type="button">🔗 Partager</button></div>`
          : '';
    let html = playAllBtn;
    for (const [album, tracks] of groups.entries()) {
      const shareAlbum = canShare()
        ? `<button class="btn btn-sm" type="button" data-share-album="${escapeAttr(album)}">🔗 Partager</button>`
        : '';
      html += `<div class="group-header"><span>💿 ${escapeHtml(album)}</span><span class="muted">${tracks.length} piste(s) ${shareAlbum}</span></div>`;
      html += listHtml(tracks);
    }
    return html;
  }

  function listHtml(items, opts = {}) {
    if (!items.length) return emptyMsg('Aucun élément.');
    return `<div class="list">${items
      .map((it) => {
        const ext = extLabel(it.filename);
        const parts = [];
        if (opts.showOrigin) {
          if (it.show_name) parts.push(it.show_name);
          if (it.artist) parts.push(it.artist);
        }
        if (it.type === 'episode') {
          parts.push(`S${String(it.season ?? 1).padStart(2, '0')}E${String(it.episode ?? 1).padStart(2, '0')}`);
        }
        if (it.type === 'track') {
          if (it.album) parts.push(it.album);
          if (it.track_num != null) parts.push('#' + it.track_num);
        }
        if (ext) parts.push(ext);
        parts.push(fmtBytes(it.size_bytes));
        const meta = parts.filter(Boolean).join(' · ');
        const shareBtn = canShare()
          ? `<button class="btn btn-share" type="button">Partager</button>`
          : '';
        const isPlaying = state.currentItem && state.currentItem.id === it.id;
        return `<div class="list-item ${isPlaying ? 'playing' : ''}" data-id="${it.id}">
          <div class="left">
            <div class="title">${iconFor(it.type)} ${escapeHtml(it.title)}</div>
            <div class="meta">${escapeHtml(meta)}</div>
          </div>
          <div class="actions">
            <button class="btn btn-primary btn-play" type="button">Lire</button>
            <button class="btn btn-dl" type="button">Télécharger</button>
            <button class="btn btn-vlc" type="button">VLC</button>
            ${shareBtn}
          </div>
        </div>`;
      })
      .join('')}</div>`;
  }

  function bindListActions() {
    const playAll = $('btnPlayAll');
    if (playAll && state.visibleItems.length) {
      playAll.addEventListener('click', () => startQueueFromItem(state.visibleItems[0].id));
    }
    content.querySelectorAll('.list-item').forEach((row) => {
      const id = Number(row.getAttribute('data-id'));
      row.querySelector('.btn-play').addEventListener('click', () => startQueueFromItem(id));
      const dl = row.querySelector('.btn-dl');
      if (dl) dl.addEventListener('click', (e) => { e.stopPropagation(); downloadMedia(id); });
      const vlc = row.querySelector('.btn-vlc');
      if (vlc) vlc.addEventListener('click', (e) => { e.stopPropagation(); openVlcModal(id); });
      const sh = row.querySelector('.btn-share');
      if (sh) sh.addEventListener('click', () => openShareModal(id));
    });
  }

  function startQueueFromItem(id) {
    const ids = (state.visibleItems || []).map((x) => x.id);
    const idx = ids.indexOf(id);
    if (idx !== -1) {
      state.queue = ids;
      state.queueIndex = idx;
    } else {
      state.queue = [id];
      state.queueIndex = 0;
    }
    playById(id);
  }

  function updateQueueButtons() {
    const hasQueue = state.queue.length > 1;
    const prev = $('btnPrev');
    const next = $('btnNext');
    prev.classList.toggle('hidden', !hasQueue);
    next.classList.toggle('hidden', !hasQueue);
    prev.disabled = state.queueIndex <= 0;
    next.disabled = state.queueIndex < 0 || state.queueIndex >= state.queue.length - 1;
    content.querySelectorAll('.list-item').forEach((row) => {
      const rid = Number(row.getAttribute('data-id'));
      row.classList.toggle('playing', Boolean(state.currentItem && state.currentItem.id === rid));
    });
  }

  function playNextInQueue() {
    if (state.queueIndex >= 0 && state.queueIndex < state.queue.length - 1) {
      state.queueIndex += 1;
      playById(state.queue[state.queueIndex]);
    }
  }

  function playPrevInQueue() {
    if (state.queueIndex > 0) {
      state.queueIndex -= 1;
      playById(state.queue[state.queueIndex]);
    }
  }

  function destroyHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch {}
      state.hls = null;
    }
  }

  function setModeButtons(mode) {
    state.playMode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function updatePlayerChrome(item) {
    const isVideo = item.type !== 'track';
    $('modeToggle').classList.toggle('hidden', !isVideo);
    const subParts = [];
    if (item.show_name) {
      subParts.push(
        `${item.show_name} · S${String(item.season ?? 1).padStart(2, '0')}E${String(item.episode ?? 1).padStart(2, '0')}`
      );
    }
    if (item.artist) {
      subParts.push(item.artist + (item.album ? ` — ${item.album}` : ''));
    }
    if (state.queue.length > 1 && state.queueIndex >= 0) {
      subParts.push(`${state.queueIndex + 1}/${state.queue.length}`);
    }
    $('nowPlayingSub').textContent = subParts.join(' · ');

    const hint = item.playback?.reason || '';
    const extra = isVideo
      ? ' Direct = fichier original. Compatible = ffmpeg H.264+AAC stéréo (pas de DTS dans le navigateur). VLC pour le Remux / 5.1.'
      : ' Téléchargez ou ouvrez dans VLC pour tous les codecs audio.';
    $('playerHint').textContent = hint + extra;
    $('btnM3u').href = '/api/media/' + item.id + '/playlist.m3u';
    updateQueueButtons();
  }

  async function playDirect(item) {
    destroyHls();
    const video = $('videoPlayer');
    const audio = $('audioPlayer');
    const src = '/api/stream/' + item.id;
    if (item.type === 'track') {
      video.classList.add('hidden');
      video.removeAttribute('src');
      audio.classList.remove('hidden');
      audio.src = src;
      audio.play().catch(() => {});
      return;
    }
    audio.classList.add('hidden');
    audio.removeAttribute('src');
    video.classList.remove('hidden');
    video.src = src;
    const onErr = () => {
      video.removeEventListener('error', onErr);
      if (item.transcodeEnabled !== false) {
        $('playerHint').textContent = 'Lecture Directe impossible — bascule en Compatible (H.264+AAC)…';
        setModeButtons('compatible');
        playCompatible(item);
      }
    };
    video.addEventListener('error', onErr);
    video.play().catch(() => {});
  }

  async function playCompatible(item) {
    destroyHls();
    const video = $('videoPlayer');
    const audio = $('audioPlayer');
    audio.classList.add('hidden');
    audio.removeAttribute('src');
    video.classList.remove('hidden');
    video.removeAttribute('src');

    $('playerHint').textContent = 'Démarrage du transcodage Compatible (H.264 + AAC stéréo)… CPU Synology sollicité.';
    let info;
    try {
      info = await api('/api/stream/' + item.id + '/hls');
    } catch (e) {
      $('playerHint').textContent = 'Compatible indisponible : ' + e.message + ' — utilisez VLC.';
      return;
    }

    const playlistUrl = info.playlistUrl || ('/api/stream/' + item.id + '/hls/playlist.m3u8');

    async function waitPlaylist(retries) {
      for (let i = 0; i < retries; i++) {
        if (!state.currentItem || state.currentItem.id !== item.id) return false;
        const res = await fetch(playlistUrl, { credentials: 'same-origin' });
        if (res.ok) {
          const text = await res.text();
          if (text.includes('#EXTM3U') && text.includes('#EXTINF:')) return true;
        }
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      return false;
    }

    const ready = await waitPlaylist(40);
    if (!ready) {
      if (state.currentItem && state.currentItem.id === item.id) {
        $('playerHint').textContent = 'Transcodage trop long / échec. Préférez VLC en LAN pour les gros Remux.';
      }
      return;
    }

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      state.hls = hls;
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          $('playerHint').textContent = 'Erreur HLS — réessayez Compatible ou ouvrez dans VLC.';
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistUrl;
      video.play().catch(() => {});
    } else {
      $('playerHint').textContent = 'HLS non supporté par ce navigateur — utilisez VLC.';
    }
  }

  async function playById(id, forceMode) {
    const item = await api('/api/media/' + id);
    state.currentItem = item;
    $('nowPlaying').textContent = item.title;
    $('playerPanel').classList.remove('hidden');
    $('btnShareCurrent').classList.toggle('hidden', !canShare());
    updatePlayerChrome(item);

    let mode = forceMode;
    if (!mode) {
      if (item.type === 'track') mode = 'direct';
      else if (item.playback && item.playback.suggestedMode === 'compatible' && item.transcodeEnabled !== false) {
        mode = 'compatible';
      } else {
        mode = 'direct';
      }
    }
    setModeButtons(mode);
    if (mode === 'compatible' && item.type !== 'track') await playCompatible(item);
    else await playDirect(item);
  }

  function downloadMedia(id) {
    window.location.href = '/api/media/' + id + '/download';
  }

  function setQrImage(imgEl, url) {
    if (!imgEl || !url) return;
    imgEl.src = '/api/qr?text=' + encodeURIComponent(url);
  }

  function openQrModal(url, title, sub) {
    $('qrModalTitle').textContent = title || 'QR Code';
    $('qrModalSub').textContent = sub || '';
    $('qrModalUrl').value = url;
    setQrImage($('qrModalImg'), url);
    $('qrModalCopied').classList.add('hidden');
    $('qrModal').classList.remove('hidden');
  }

  async function openVlcModal(id) {
    try {
      const data = await api('/api/media/' + id + '/vlc');
      $('vlcUrl').value = data.streamUrl;
      $('vlcM3uLink').href = data.m3uUrl;
      setQrImage($('vlcQrImg'), data.streamUrl);
      $('vlcCopied').classList.add('hidden');
      $('vlcModal').classList.remove('hidden');
      try {
        await navigator.clipboard.writeText(data.streamUrl);
        $('vlcCopied').classList.remove('hidden');
      } catch {}
    } catch (e) {
      alert(e.message);
    }
  }

  let shareTarget = null;
  function openShareModal(target) {
    if (!canShare()) return;
    if (typeof target === 'number') {
      shareTarget = { targetType: 'media', mediaId: target };
    } else {
      shareTarget = target;
    }
    $('shareError').classList.add('hidden');
    $('shareResult').classList.add('hidden');
    $('shareQrBox').classList.add('hidden');
    $('shareExpires').value = '';
    $('shareMaxUses').value = '';
    $('sharePassword').value = '';
    $('shareCreate').classList.remove('hidden');
    const kind = shareTarget.targetType || 'media';
    $('shareModalTitle').textContent =
      kind === 'media' ? 'Lien de partage (1 média)' : 'Lien de partage (collection)';
    if (kind === 'media' && shareTarget.mediaId) {
      api('/api/media/' + shareTarget.mediaId).then((item) => {
        $('shareMediaTitle').textContent = item.title;
        $('shareModal').classList.remove('hidden');
      });
    } else {
      $('shareMediaTitle').textContent = shareTarget.label || kind;
      $('shareModal').classList.remove('hidden');
    }
  }

  async function renderShares() {
    const data = await api('/api/shares');
    const shares = data.shares || [];
    if (data.publicBaseUrl) state.publicBaseUrl = data.publicBaseUrl;
    const banner = isAdmin()
      ? `<div class="public-url-banner">
          <h3>🌐 URL Internet / Accès distant</h3>
          <p class="muted">Tailscale, Cloudflare Tunnel, DDNS ou IP LAN — utilisée pour les liens de partage et les QR codes.</p>
          <div class="public-url-row">
            <input id="publicUrlInput" type="url" placeholder="https://media.tailnet.ts.net" value="${escapeAttr(
              state.publicBaseUrl || ''
            )}" />
            <button class="btn btn-primary" id="btnSavePublicUrl" type="button">Enregistrer</button>
            <button class="btn btn-ghost" id="btnClearPublicUrl" type="button">Réinit.</button>
          </div>
          <p class="ok hidden" id="publicUrlOk"></p>
          <p class="error hidden" id="publicUrlErr"></p>
        </div>`
      : '';
    if (!shares.length) {
      content.innerHTML = banner + emptyMsg('Aucun partage. Ouvrez un média ou un dossier et cliquez sur Partager.');
    } else {
      content.innerHTML =
        banner +
        `<div class="list">${shares
          .map((s) => {
            const exp = s.expires_at ? new Date(s.expires_at).toLocaleString() : 'jamais';
            const uses = s.max_uses != null ? `${s.use_count}/${s.max_uses}` : `${s.use_count}`;
            const url = s.url || location.origin + '/s/' + s.token;
            const kind = s.target_type && s.target_type !== 'media' ? ` · ${s.target_type}` : '';
            return `<div class="list-item">
          <div class="left">
            <div class="title">${escapeHtml(s.title)}</div>
            <div class="meta">par ${escapeHtml(s.created_by_name || '?')} · exp: ${escapeHtml(exp)} · uses: ${uses}${
              s.password_hash ? ' · 🔒' : ''
            }${kind}</div>
          </div>
          <div class="actions">
            <button class="btn" data-copy="${escapeAttr(url)}" type="button">Copier</button>
            <button class="btn" data-qr="${escapeAttr(url)}" data-qr-title="${escapeAttr(s.title)}" type="button">📱 QR</button>
            <button class="btn btn-danger" data-revoke="${s.id}" type="button">Révoquer</button>
          </div>
        </div>`;
          })
          .join('')}</div>`;
    }
    const saveBtn = $('btnSavePublicUrl');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        $('publicUrlOk').classList.add('hidden');
        $('publicUrlErr').classList.add('hidden');
        try {
          const r = await api('/api/admin/settings/public-url', {
            method: 'PUT',
            body: JSON.stringify({ publicBaseUrl: $('publicUrlInput').value.trim() || null }),
          });
          state.publicBaseUrl = r.publicBaseUrl;
          $('publicUrlOk').textContent = 'URL enregistrée : ' + r.publicBaseUrl;
          $('publicUrlOk').classList.remove('hidden');
          renderShares();
        } catch (e) {
          $('publicUrlErr').textContent = e.message;
          $('publicUrlErr').classList.remove('hidden');
        }
      });
    }
    const clearBtn = $('btnClearPublicUrl');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          await api('/api/admin/settings/public-url', {
            method: 'PUT',
            body: JSON.stringify({ publicBaseUrl: null }),
          });
          renderShares();
        } catch (e) {
          alert(e.message);
        }
      });
    }
    content.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-copy');
        await navigator.clipboard.writeText(url);
        btn.textContent = 'OK';
        setTimeout(() => (btn.textContent = 'Copier'), 1200);
      });
    });
    content.querySelectorAll('[data-qr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openQrModal(btn.getAttribute('data-qr'), btn.getAttribute('data-qr-title') || 'QR Code', 'Scannez pour ouvrir le partage');
      });
    });
    content.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Révoquer ce lien ?')) return;
        await api('/api/shares/' + btn.getAttribute('data-revoke'), { method: 'DELETE' });
        renderShares();
      });
    });
  }

  // ---- Admin users ----
  async function renderAdminUsers() {
    const data = await api('/api/admin/users');
    const libsData = await api('/api/admin/libraries');
    state.allLibsAdmin = libsData.libraries || [];
    const users = data.users || [];
    content.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-primary" id="btnNewUser" type="button">+ Nouvel utilisateur</button>
      </div>
      <table class="table">
        <thead><tr><th>Compte</th><th>Rôle</th><th>Statut</th><th>Bibliothèques</th><th></th></tr></thead>
        <tbody>
          ${users
            .map((u) => {
              const libNames = (u.library_ids || [])
                .map((id) => state.allLibsAdmin.find((l) => l.id === id)?.name || id)
                .join(', ');
              const canDelete = state.user && state.user.id !== u.id;
              return `<tr>
              <td><strong>${escapeHtml(u.username)}</strong><div class="muted" style="font-size:0.78rem">#${u.id}</div></td>
              <td><span class="badge">${escapeHtml(u.role)}</span></td>
              <td>
                <span class="badge ${u.enabled ? 'ok' : 'warn'}">${u.enabled ? 'actif' : 'désactivé'}</span>
                ${u.can_share ? '<span class="badge">partage</span>' : ''}
              </td>
              <td class="muted">${u.role === 'admin' ? 'toutes' : escapeHtml(libNames || '—')}</td>
              <td style="display:flex;gap:0.35rem;flex-wrap:wrap">
                <button class="btn" data-edit-user="${u.id}" type="button">Modifier</button>
                <button class="btn" data-qr-user="${escapeAttr(u.username)}" type="button">📱 QR Accès</button>
                ${
                  canDelete
                    ? `<button class="btn btn-danger" data-del-user="${u.id}" type="button">Suppr.</button>`
                    : ''
                }
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
    $('btnNewUser').onclick = () => openUserModal(null);
    content.querySelectorAll('[data-edit-user]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const u = users.find((x) => x.id === Number(btn.getAttribute('data-edit-user')));
        openUserModal(u);
      });
    });
    content.querySelectorAll('[data-del-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const u = users.find((x) => x.id === Number(btn.getAttribute('data-del-user')));
        if (!u || !confirm(`Supprimer le compte "${u.username}" ?`)) return;
        try {
          await api('/api/admin/users/' + u.id, { method: 'DELETE' });
          renderAdminUsers();
        } catch (e) {
          alert(e.message);
        }
      });
    });
    content.querySelectorAll('[data-qr-user]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const username = btn.getAttribute('data-qr-user');
        const base = (state.publicBaseUrl || location.origin).replace(/\/+$/, '');
        const url = `${base}/login.html?user=${encodeURIComponent(username)}`;
        openQrModal(url, 'QR Accès — ' + username, 'Scannez pour ouvrir la page de connexion');
      });
    });
  }

  function openUserModal(user) {
    state.editUserId = user ? user.id : null;
    $('userModalTitle').textContent = user ? 'Modifier ' + user.username : 'Nouvel utilisateur';
    $('uName').value = user ? user.username : '';
    $('uName').disabled = !!user;
    $('uPass').value = '';
    $('uRole').value = user ? user.role : 'user';
    $('uShare').checked = user ? !!user.can_share : true;
    $('uEnabled').checked = user ? !!user.enabled : true;
    $('uEnabled').closest('.field').classList.toggle('hidden', !user);
    $('userError').classList.add('hidden');
    $('uLibs').innerHTML = state.allLibsAdmin
      .map((l) => {
        const checked = user ? (user.library_ids || []).includes(l.id) : !!l.enabled;
        return `<label><input type="checkbox" value="${l.id}" ${checked ? 'checked' : ''}/> ${escapeHtml(
          l.name
        )} <span class="muted">(${l.type})</span></label>`;
      })
      .join('');
    $('userModal').classList.remove('hidden');
  }

  // ---- Admin libraries ----
  async function renderAdminLibs() {
    const data = await api('/api/admin/libraries');
    const libs = data.libraries || [];
    content.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-primary" id="btnNewLib" type="button">+ Bibliothèque</button>
      </div>
      <table class="table">
        <thead><tr><th>Nom</th><th>Type</th><th>Chemin</th><th>Médias</th><th>Statut</th><th></th></tr></thead>
        <tbody>
          ${libs
            .map(
              (l) => `<tr>
              <td><strong>${escapeHtml(l.name)}</strong></td>
              <td>${iconFor(l.type)} ${escapeHtml(l.type)}</td>
              <td class="muted" style="font-size:0.8rem">${escapeHtml(l.path)}<div>${escapeHtml(l.resolved_path)}</div></td>
              <td>${l.item_count}</td>
              <td><span class="badge ${l.enabled ? 'ok' : 'warn'}">${l.enabled ? 'active' : 'off'}</span></td>
              <td style="display:flex;gap:0.35rem;flex-wrap:wrap">
                <button class="btn" data-edit-lib="${l.id}" type="button">Modifier</button>
                <button class="btn" data-scan-lib="${l.id}" type="button">Scan</button>
                <button class="btn btn-danger" data-del-lib="${l.id}" type="button">Suppr.</button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
    $('btnNewLib').onclick = () => openLibModal(null);
    content.querySelectorAll('[data-edit-lib]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openLibModal(libs.find((l) => l.id === Number(btn.getAttribute('data-edit-lib'))));
      });
    });
    content.querySelectorAll('[data-scan-lib]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await api('/api/rescan', {
          method: 'POST',
          body: JSON.stringify({ libraryId: Number(btn.getAttribute('data-scan-lib')) }),
        });
        alert(`Scan: ${r.scanned} fichiers, +${r.added}, ~${r.updated}, -${r.removed}`);
        refreshStats();
        renderAdminLibs();
      });
    });
    content.querySelectorAll('[data-del-lib]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer cette bibliothèque et ses médias indexés ?')) return;
        await api('/api/admin/libraries/' + btn.getAttribute('data-del-lib'), { method: 'DELETE' });
        refreshStats();
        renderAdminLibs();
      });
    });
  }

  function openLibModal(lib) {
    state.editLibId = lib ? lib.id : null;
    $('libModalTitle').textContent = lib ? 'Modifier ' + lib.name : 'Nouvelle bibliothèque';
    $('lName').value = lib ? lib.name : '';
    $('lType').value = lib ? lib.type : 'movies';
    $('lType').disabled = !!lib;
    $('lPath').value = lib ? lib.path : '';
    $('lEnabled').checked = lib ? !!lib.enabled : true;
    $('lEnabled').closest('.field').classList.toggle('hidden', !lib);
    $('libError').classList.add('hidden');
    $('libModal').classList.remove('hidden');
  }

  // Events
  document.querySelectorAll('#nav button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      render();
    }, 250);
  });

  $('btnRescan').addEventListener('click', async () => {
    $('btnRescan').disabled = true;
    $('btnRescan').textContent = 'Scan…';
    try {
      const r = await api('/api/rescan', { method: 'POST', body: '{}' });
      alert(
        `Scan terminé\nBibliothèques: ${r.libraries}\nFichiers: ${r.scanned}\n+${r.added} ~${r.updated} -${r.removed}`
      );
      await refreshStats();
      render();
    } catch (e) {
      alert(e.message);
    } finally {
      $('btnRescan').disabled = false;
      $('btnRescan').textContent = 'Rescan';
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/login.html';
  });

  $('btnChangePwd').addEventListener('click', () => {
    $('curPwd').value = '';
    $('newPwd').value = '';
    $('pwdModalError').classList.add('hidden');
    $('pwdModalOk').classList.add('hidden');
    $('pwdModal').classList.remove('hidden');
  });
  $('pwdModalCancel').addEventListener('click', () => $('pwdModal').classList.add('hidden'));
  $('pwdModalSave').addEventListener('click', async () => {
    $('pwdModalError').classList.add('hidden');
    $('pwdModalOk').classList.add('hidden');
    try {
      await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: $('curPwd').value,
          newPassword: $('newPwd').value,
        }),
      });
      $('pwdModalOk').textContent = 'Mot de passe mis à jour !';
      $('pwdModalOk').classList.remove('hidden');
      $('curPwd').value = '';
      $('newPwd').value = '';
    } catch (e) {
      $('pwdModalError').textContent = e.message;
      $('pwdModalError').classList.remove('hidden');
    }
  });

  $('btnClosePlayer').addEventListener('click', () => {
    $('playerPanel').classList.add('hidden');
    destroyHls();
    state.currentItem = null;
    $('videoPlayer').pause();
    $('videoPlayer').removeAttribute('src');
    $('audioPlayer').pause();
    $('audioPlayer').removeAttribute('src');
    updateQueueButtons();
  });

  $('btnPrev').addEventListener('click', playPrevInQueue);
  $('btnNext').addEventListener('click', playNextInQueue);
  $('videoPlayer').addEventListener('ended', playNextInQueue);
  $('audioPlayer').addEventListener('ended', playNextInQueue);

  $('btnShareCurrent').addEventListener('click', () => {
    if (state.currentItem) openShareModal(state.currentItem.id);
  });

  $('btnModeDirect').addEventListener('click', () => {
    if (!state.currentItem) return;
    setModeButtons('direct');
    playDirect(state.currentItem);
  });
  $('btnModeCompat').addEventListener('click', () => {
    if (!state.currentItem || state.currentItem.type === 'track') return;
    setModeButtons('compatible');
    playCompatible(state.currentItem);
  });
  $('btnDownload').addEventListener('click', () => {
    if (state.currentItem) downloadMedia(state.currentItem.id);
  });
  $('btnVlc').addEventListener('click', () => {
    if (state.currentItem) openVlcModal(state.currentItem.id);
  });
  $('vlcClose').addEventListener('click', () => $('vlcModal').classList.add('hidden'));
  $('qrModalClose').addEventListener('click', () => $('qrModal').classList.add('hidden'));
  $('qrModalCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('qrModalUrl').value);
      $('qrModalCopied').classList.remove('hidden');
    } catch {}
  });
  $('vlcCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('vlcUrl').value);
      $('vlcCopied').classList.remove('hidden');
    } catch {}
  });

  document.querySelectorAll('[data-exp-hours]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const hours = Number(btn.getAttribute('data-exp-hours'));
      if (!hours) {
        $('shareExpires').value = '';
        return;
      }
      const d = new Date(Date.now() + hours * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const localIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours()
      )}:${pad(d.getMinutes())}`;
      $('shareExpires').value = localIso;
    });
  });

  $('shareCancel').addEventListener('click', () => $('shareModal').classList.add('hidden'));
  $('shareCreate').addEventListener('click', async () => {
    $('shareError').classList.add('hidden');
    try {
      const rawExp = $('shareExpires').value.trim();
      const expiresAt = rawExp ? new Date(rawExp).toISOString() : null;
      const share = await api('/api/shares', {
        method: 'POST',
        body: JSON.stringify({
          targetType: (shareTarget && shareTarget.targetType) || 'media',
          mediaId: shareTarget && shareTarget.mediaId,
          libraryId: shareTarget && shareTarget.libraryId,
          folderPath: shareTarget && shareTarget.folderPath,
          showName: shareTarget && shareTarget.showName,
          season: shareTarget && shareTarget.season,
          artist: shareTarget && shareTarget.artist,
          album: shareTarget && shareTarget.album,
          label: shareTarget && shareTarget.label,
          expiresAt,
          maxUses: $('shareMaxUses').value ? Number($('shareMaxUses').value) : null,
          password: $('sharePassword').value || null,
        }),
      });
      const el = $('shareResult');
      el.textContent = 'Lien copié : ' + share.url;
      el.classList.remove('hidden');
      $('shareUrlOut').value = share.url;
      setQrImage($('shareQrImg'), share.url);
      $('shareQrBox').classList.remove('hidden');
      try {
        await navigator.clipboard.writeText(share.url);
      } catch {}
    } catch (e) {
      $('shareError').textContent = e.message;
      $('shareError').classList.remove('hidden');
    }
  });

  $('userCancel').addEventListener('click', () => $('userModal').classList.add('hidden'));
  $('userSave').addEventListener('click', async () => {
    $('userError').classList.add('hidden');
    const library_ids = [...$('uLibs').querySelectorAll('input:checked')].map((i) => Number(i.value));
    try {
      if (state.editUserId) {
        const body = {
          role: $('uRole').value,
          enabled: $('uEnabled').checked,
          can_share: $('uShare').checked,
          library_ids,
        };
        if ($('uPass').value) body.password = $('uPass').value;
        await api('/api/admin/users/' + state.editUserId, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: $('uName').value,
            password: $('uPass').value,
            role: $('uRole').value,
            can_share: $('uShare').checked,
            library_ids,
          }),
        });
      }
      $('userModal').classList.add('hidden');
      renderAdminUsers();
    } catch (e) {
      $('userError').textContent = e.message;
      $('userError').classList.remove('hidden');
    }
  });

  $('libCancel').addEventListener('click', () => $('libModal').classList.add('hidden'));
  $('libSave').addEventListener('click', async () => {
    $('libError').classList.add('hidden');
    try {
      if (state.editLibId) {
        await api('/api/admin/libraries/' + state.editLibId, {
          method: 'PATCH',
          body: JSON.stringify({
            name: $('lName').value,
            path: $('lPath').value,
            enabled: $('lEnabled').checked,
          }),
        });
      } else {
        await api('/api/admin/libraries', {
          method: 'POST',
          body: JSON.stringify({
            name: $('lName').value,
            type: $('lType').value,
            path: $('lPath').value,
          }),
        });
      }
      $('libModal').classList.add('hidden');
      refreshStats();
      renderAdminLibs();
    } catch (e) {
      $('libError').textContent = e.message;
      $('libError').classList.remove('hidden');
    }
  });

  (async () => {
    const me = await fetch('/api/me').then((r) => r.json());
    if (!me.authenticated) {
      location.href = '/login.html';
      return;
    }
    state.user = me.user;
    $('whoami').textContent = `${me.user.username} · ${me.user.role}`;
    document.querySelectorAll('.admin-only').forEach((el) => {
      el.classList.toggle('hidden', me.user.role !== 'admin');
    });
    await refreshStats();
    render();
  })();
})();
