// Loaded (deferred) on every page via partials/head.ejs so the site
// registers as an installable PWA no matter which page someone lands on
// first, and so Settings > Install App's button/status text - the only
// place with matching element ids - has a live install prompt to use by
// the time that panel loads. Everywhere else this is a silent no-op.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        // Best-effort - the site is fully usable without it either way.
      });
    });
  }

  // The browser only offers this once per page load (and only when it
  // has decided the page qualifies), so it's stashed on window rather
  // than assumed to still be around later - the Install App button
  // reuses this same page load's prompt, it never fetches a new one.
  window.__pwaDeferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaDeferredPrompt = e;
    document.dispatchEvent(new CustomEvent('pwa-installable'));
  });
  window.addEventListener('appinstalled', function () {
    window.__pwaDeferredPrompt = null;
    document.dispatchEvent(new CustomEvent('pwa-installed'));
  });

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function wireInstallPanel() {
    var btn = document.getElementById('pwa-install-btn');
    var statusEl = document.getElementById('pwa-install-status');
    if (!btn || !statusEl) return; // Install App tab isn't on this page

    if (isStandalone()) {
      btn.hidden = true;
      statusEl.textContent = 'Installed ✓ You’re using the installed app on this device.';
      return;
    }

    function refresh() {
      if (window.__pwaDeferredPrompt) {
        btn.hidden = false;
        btn.disabled = false;
        statusEl.textContent = '';
      } else {
        btn.hidden = true;
        statusEl.textContent = 'One-tap install isn’t available in this browser right now - use the steps below instead.';
      }
    }
    refresh();
    document.addEventListener('pwa-installable', refresh);
    document.addEventListener('pwa-installed', function () {
      btn.hidden = true;
      statusEl.textContent = 'Installed ✓ Look for it on your device’s home screen or app list.';
    });

    btn.addEventListener('click', function () {
      var promptEvent = window.__pwaDeferredPrompt;
      if (!promptEvent) return;
      btn.disabled = true;
      promptEvent.prompt();
      promptEvent.userChoice.finally(function () {
        window.__pwaDeferredPrompt = null;
        refresh();
      });
    });
  }

  wireInstallPanel();
})();
