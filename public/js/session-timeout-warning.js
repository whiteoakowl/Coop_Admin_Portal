// Warns before the admin session's fixed-length cookie actually expires -
// this app's session isn't `rolling` (server.js), so unlike a lot of
// session-timeout UIs, browsing around never pushes the deadline back;
// it's a single fixed point in time set at login. Without a warning, the
// first sign of expiry is a POST silently bouncing to the login page with
// whatever was being typed lost - see public/js/unsaved-changes.js for
// the other half of that same problem.
//
// Included from partials/admin-nav.ejs (admin pages only), reading the
// deadline off session-timeout-dialog.ejs's data-expires-at, which
// server.js sets from req.session.cookie.expires alongside the CSRF
// token.
(function () {
  const dialog = document.getElementById('session-timeout-dialog');
  if (!dialog) return;
  const expiresAtRaw = dialog.dataset.expiresAt;
  if (!expiresAtRaw) return;
  const expiresAt = new Date(expiresAtRaw).getTime();
  if (Number.isNaN(expiresAt)) return;

  const WARN_MS = 5 * 60 * 1000;
  const countdownEl = document.getElementById('session-timeout-countdown');
  const loginLink = document.getElementById('session-timeout-login-link');
  // Sends them back to /admin/login already pointed at wherever they
  // were - safeNext() on the server validates this before ever honoring
  // it, same as every other login redirect (see routes/admin.js).
  if (loginLink) loginLink.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search);

  let tickTimer = null;

  function tick() {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      if (countdownEl) countdownEl.textContent = '0:00';
      clearInterval(tickTimer);
      return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (countdownEl) countdownEl.textContent = minutes + ':' + String(seconds).padStart(2, '0');
  }

  function showWarning() {
    if (dialog.open) return;
    tick();
    tickTimer = setInterval(tick, 1000);
    dialog.showModal();

    const dismissBtn = document.getElementById('session-timeout-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', () => dialog.close(), { once: true });
    dialog.addEventListener('close', () => clearInterval(tickTimer), { once: true });
  }

  const msUntilWarn = expiresAt - WARN_MS - Date.now();
  if (msUntilWarn <= 0) showWarning();
  else setTimeout(showWarning, msUntilWarn);
})();
