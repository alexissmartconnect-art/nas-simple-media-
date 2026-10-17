/* Login page (no inline script: compatible with the strict CSP). */
(() => {
  const $ = (id) => document.getElementById(id);
  let lastPassword = '';
  let minLen = 10;

  function showChangeForm(knownCurrentPassword) {
    $('loginForm').classList.add('hidden');
    $('changeForm').classList.remove('hidden');
    $('minLen').textContent = String(minLen);
    $('newPassword').minLength = minLen;
    $('newPassword2').minLength = minLen;
    if (knownCurrentPassword) {
      $('curPassword').value = knownCurrentPassword;
      $('curPwdField').classList.add('hidden');
    } else {
      $('curPwdField').classList.remove('hidden');
    }
    $('newPassword').focus();
  }

  (async () => {
    const params = new URLSearchParams(location.search);
    const preset = params.get('user') || params.get('username');
    if (preset) $('username').value = preset;
    try {
      const me = await fetch('/api/me').then((r) => r.json());
      if (me.passwordMinLength) minLen = me.passwordMinLength;
      if (me.authenticated && me.mustChangePassword) {
        showChangeForm('');
        return;
      }
      if (me.authenticated) location.href = '/';
    } catch {}
    // First run (LAN only): tell the owner that the default account is still active.
    try {
      const setup = await fetch('/api/setup/status').then((r) => r.json());
      if (setup && setup.passwordMinLength) minLen = setup.passwordMinLength;
      if (setup && setup.defaultAdminActive) {
        const hint = $('firstRunHint');
        hint.textContent = '';
        hint.append(
          'Première connexion : identifiant ',
          Object.assign(document.createElement('strong'), { textContent: String(setup.defaultAdminUser || 'admin') }),
          ', mot de passe ',
          Object.assign(document.createElement('strong'), { textContent: 'changeme' }),
          ' — un nouveau mot de passe vous sera demandé immédiatement.'
        );
        hint.classList.remove('hidden');
      }
    } catch {}
  })();

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('error');
    err.classList.add('hidden');
    lastPassword = $('password').value;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: lastPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || 'Échec de connexion';
      err.classList.remove('hidden');
      return;
    }
    if (data.mustChangePassword) {
      showChangeForm(lastPassword);
      return;
    }
    location.href = '/';
  });

  $('changeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('changeError');
    err.classList.add('hidden');
    const next = $('newPassword').value;
    if (next !== $('newPassword2').value) {
      err.textContent = 'Les deux mots de passe ne correspondent pas.';
      err.classList.remove('hidden');
      return;
    }
    if (next.length < minLen) {
      err.textContent = 'Au moins ' + minLen + ' caractères.';
      err.classList.remove('hidden');
      return;
    }
    const res = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('curPassword').value, newPassword: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || 'Échec du changement de mot de passe';
      err.classList.remove('hidden');
      if (res.status === 400 && /actuel/.test(String(data.error || ''))) {
        $('curPwdField').classList.remove('hidden');
      }
      return;
    }
    location.href = '/';
  });

  $('changeLogout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {}
    location.href = '/login.html';
  });
})();
