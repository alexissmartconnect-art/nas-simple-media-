/* NAS Simple Media — PWA : enregistrement du service worker + bouton « Installer l’appli ». */
(function () {
  'use strict';

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
        console.warn('[pwa] service worker non enregistré :', err);
      });
    });
  }

  var deferredPrompt = null;
  function installButton() {
    return document.getElementById('btnInstall');
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var btn = installButton();
    if (btn) btn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var btn = installButton();
    if (btn) btn.classList.add('hidden');
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('#btnInstall') : null;
    if (!btn || !deferredPrompt) return;
    var prompt = deferredPrompt;
    deferredPrompt = null;
    btn.classList.add('hidden');
    prompt.prompt();
    if (prompt.userChoice) prompt.userChoice.catch(function () {});
  });
})();
