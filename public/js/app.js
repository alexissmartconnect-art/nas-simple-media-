(() => {
  const state = {
    user: null,
    view: 'browse',
    libraries: [],
    library: null, // selected library object
    drill: null, // show name / artist
    currentItem: null,
    q: '',
    editUserId: null,
    editLibId: null,
    allLibsAdmin: [],
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
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
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
      sectionTitle.textContent = 'Bibliothèques';
      await loadLibraries();
      if (!state.libraries.length) {
        content.innerHTML = emptyMsg(
          isAdmin()
            ? 'Aucune bibliothèque. Créez-en une dans Admin · Bibliothèques, puis Rescan.'
            : 'Aucune bibliothèque partagée avec votre compte. Demandez à un admin.'
        );
        return;
      }
      let libs = state.libraries;
      if (state.q) {
        const qq = state.q.toLowerCase();
        libs = libs.filter((l) => l.name.toLowerCase().includes(qq));
      }
      content.innerHTML = `<div class="grid">${libs
        .map(
          (l) => `<article class="card" data-lib="${l.id}">
          <div class="thumb">${iconFor(l.type)}</div>
          <div>
            <div class="title">${escapeHtml(l.name)}</div>
            <div class="meta">${escapeHtml(l.type)} · ${l.item_count} média(s)</div>
          </div>
        </article>`
        )
        .join('')}</div>`;
      content.querySelectorAll('[data-lib]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = Number(el.getAttribute('data-lib'));
          state.library = state.libraries.find((l) => l.id === id);
          state.drill = null;
          render();
        });
      });
      return;
    }

    const lib = state.library;
    if (lib.type === 'movies') {
      sectionTitle.textContent = lib.name;
      const data = await api(
        `/api/media?library_id=${lib.id}&limit=500` + (state.q ? '&q=' + encodeURIComponent(state.q) : '')
      );
      content.innerHTML =
        crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
        cardsHtml(data.items);
      bindCards();
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
        content.innerHTML =
          crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
          (shows.length
            ? `<div class="grid">${shows
                .map(
                  (s) => `<article class="card" data-show="${escapeAttr(s.name)}">
                <div class="thumb">📺</div>
                <div>
                  <div class="title">${escapeHtml(s.name)}</div>
                  <div class="meta">${s.seasons} saison(s) · ${s.episodes} ép.</div>
                </div>
              </article>`
                )
                .join('')}</div>`
            : emptyMsg('Aucun épisode. Ajoutez des fichiers puis Rescan (admin).'));
        content.querySelectorAll('[data-show]').forEach((el) => {
          el.addEventListener('click', () => {
            state.drill = el.getAttribute('data-show');
            render();
          });
        });
        return;
      }
      sectionTitle.textContent = state.drill;
      const data = await api(
        `/api/media?library_id=${lib.id}&show=${encodeURIComponent(state.drill)}&limit=500` +
          (state.q ? '&q=' + encodeURIComponent(state.q) : '')
      );
      content.innerHTML =
        crumb([
          ['Bibliothèques', () => { state.library = null; state.drill = null; render(); }],
          [lib.name, () => { state.drill = null; render(); }],
          [state.drill],
        ]) + listHtml(data.items);
      bindListActions();
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
      content.innerHTML =
        crumb([['Bibliothèques', () => { state.library = null; render(); }], [lib.name]]) +
        (artists.length
          ? `<div class="grid">${artists
              .map(
                (a) => `<article class="card" data-artist="${escapeAttr(a.name)}">
              <div class="thumb">🎵</div>
              <div>
                <div class="title">${escapeHtml(a.name)}</div>
                <div class="meta">${a.albums} album(s) · ${a.tracks} pistes</div>
              </div>
            </article>`
              )
              .join('')}</div>`
          : emptyMsg('Aucune musique. Ajoutez des fichiers puis Rescan (admin).'));
      content.querySelectorAll('[data-artist]').forEach((el) => {
        el.addEventListener('click', () => {
          state.drill = el.getAttribute('data-artist');
          render();
        });
      });
      return;
    }
    sectionTitle.textContent = state.drill;
    const data = await api(
      `/api/media?library_id=${lib.id}&artist=${encodeURIComponent(state.drill)}&limit=500` +
        (state.q ? '&q=' + encodeURIComponent(state.q) : '')
    );
    content.innerHTML =
      crumb([
        ['Bibliothèques', () => { state.library = null; state.drill = null; render(); }],
        [lib.name, () => { state.drill = null; render(); }],
        [state.drill],
      ]) + listHtml(data.items);
    bindListActions();
  }

  function crumb(parts) {
    // parts: [label] or [label, onClick]
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
      .map(
        (it) => `<article class="card" data-id="${it.id}">
        <div class="thumb">${iconFor(it.type)}</div>
        <div>
          <div class="title">${escapeHtml(it.title)}</div>
          <div class="meta">${fmtBytes(it.size_bytes)}</div>
        </div>
      </article>`
      )
      .join('')}</div>`;
  }

  function bindCards() {
    content.querySelectorAll('.card[data-id]').forEach((el) => {
      el.addEventListener('click', () => playById(Number(el.getAttribute('data-id'))));
    });
  }

  function listHtml(items) {
    if (!items.length) return emptyMsg('Aucun élément.');
    return `<div class="list">${items
      .map((it) => {
        let meta = fmtBytes(it.size_bytes);
        if (it.type === 'episode') {
          meta = `S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')} · ${meta}`;
        }
        if (it.type === 'track') {
          meta = `${it.album || ''}${it.track_num != null ? ' · #' + it.track_num : ''} · ${meta}`;
        }
        const shareBtn = canShare()
          ? `<button class="btn btn-share" type="button">Partager</button>`
          : '';
        return `<div class="list-item" data-id="${it.id}">
          <div class="left">
            <div class="title">${iconFor(it.type)} ${escapeHtml(it.title)}</div>
            <div class="meta">${escapeHtml(meta)}</div>
          </div>
          <div class="actions">
            <button class="btn btn-primary btn-play" type="button">Lire</button>
            ${shareBtn}
          </div>
        </div>`;
      })
      .join('')}</div>`;
  }

  function bindListActions() {
    content.querySelectorAll('.list-item').forEach((row) => {
      const id = Number(row.getAttribute('data-id'));
      row.querySelector('.btn-play').addEventListener('click', () => playById(id));
      const sh = row.querySelector('.btn-share');
      if (sh) sh.addEventListener('click', () => openShareModal(id));
    });
  }

  async function playById(id) {
    const item = await api('/api/media/' + id);
    state.currentItem = item;
    $('nowPlaying').textContent = item.title;
    $('playerPanel').classList.remove('hidden');
    $('btnShareCurrent').classList.toggle('hidden', !canShare());
    const video = $('videoPlayer');
    const audio = $('audioPlayer');
    const src = '/api/stream/' + id;
    if (item.type === 'track') {
      video.classList.add('hidden');
      video.removeAttribute('src');
      audio.classList.remove('hidden');
      audio.src = src;
      audio.play().catch(() => {});
    } else {
      audio.classList.add('hidden');
      audio.removeAttribute('src');
      video.classList.remove('hidden');
      video.src = src;
      video.play().catch(() => {});
    }
  }

  let shareMediaId = null;
  function openShareModal(id) {
    if (!canShare()) return;
    shareMediaId = id;
    $('shareError').classList.add('hidden');
    $('shareResult').classList.add('hidden');
    $('shareExpires').value = '';
    $('shareMaxUses').value = '';
    $('sharePassword').value = '';
    api('/api/media/' + id).then((item) => {
      $('shareMediaTitle').textContent = item.title;
      $('shareModal').classList.remove('hidden');
    });
  }

  async function renderShares() {
    const data = await api('/api/shares');
    const shares = data.shares || [];
    if (!shares.length) {
      content.innerHTML = emptyMsg('Aucun partage. Ouvrez un média et cliquez sur Partager.');
      return;
    }
    content.innerHTML = `<div class="list">${shares
      .map((s) => {
        const exp = s.expires_at ? new Date(s.expires_at).toLocaleString() : 'jamais';
        const uses = s.max_uses != null ? `${s.use_count}/${s.max_uses}` : `${s.use_count}`;
        return `<div class="list-item">
          <div class="left">
            <div class="title">${escapeHtml(s.title)}</div>
            <div class="meta">par ${escapeHtml(s.created_by_name || '?')} · exp: ${escapeHtml(exp)} · uses: ${uses}${
          s.password_hash ? ' · 🔒' : ''
        }</div>
          </div>
          <div class="actions">
            <button class="btn" data-copy="${escapeAttr('/s/' + s.token)}" type="button">Copier</button>
            <button class="btn btn-danger" data-revoke="${s.id}" type="button">Révoquer</button>
          </div>
        </div>`;
      })
      .join('')}</div>`;
    content.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const url = location.origin + btn.getAttribute('data-copy');
        await navigator.clipboard.writeText(url);
        btn.textContent = 'OK';
        setTimeout(() => (btn.textContent = 'Copier'), 1200);
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
              return `<tr>
              <td><strong>${escapeHtml(u.username)}</strong><div class="muted" style="font-size:0.78rem">#${u.id}</div></td>
              <td><span class="badge">${escapeHtml(u.role)}</span></td>
              <td>
                <span class="badge ${u.enabled ? 'ok' : 'warn'}">${u.enabled ? 'actif' : 'désactivé'}</span>
                ${u.can_share ? '<span class="badge">partage</span>' : ''}
              </td>
              <td class="muted">${u.role === 'admin' ? 'toutes' : escapeHtml(libNames || '—')}</td>
              <td><button class="btn" data-edit-user="${u.id}" type="button">Modifier</button></td>
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
      .map(
        (l) =>
          `<label><input type="checkbox" value="${l.id}" ${
            user && (user.library_ids || []).includes(l.id) ? 'checked' : ''
          }/> ${escapeHtml(l.name)} <span class="muted">(${l.type})</span></label>`
      )
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

  $('btnClosePlayer').addEventListener('click', () => {
    $('playerPanel').classList.add('hidden');
    $('videoPlayer').pause();
    $('audioPlayer').pause();
  });

  $('btnShareCurrent').addEventListener('click', () => {
    if (state.currentItem) openShareModal(state.currentItem.id);
  });

  $('shareCancel').addEventListener('click', () => $('shareModal').classList.add('hidden'));
  $('shareCreate').addEventListener('click', async () => {
    $('shareError').classList.add('hidden');
    try {
      const share = await api('/api/shares', {
        method: 'POST',
        body: JSON.stringify({
          mediaId: shareMediaId,
          expiresAt: $('shareExpires').value.trim() || null,
          maxUses: $('shareMaxUses').value ? Number($('shareMaxUses').value) : null,
          password: $('sharePassword').value || null,
        }),
      });
      const el = $('shareResult');
      el.textContent = 'Lien: ' + share.url;
      el.classList.remove('hidden');
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
