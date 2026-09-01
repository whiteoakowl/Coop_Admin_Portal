(function () {
  // Two buttons can exist on the same page (desktop corner button + mobile
  // topbar icon, see partials/admin-nav.ejs) - both toggle the same
  // fullscreen state and stay in sync with each other and with whatever
  // else changed fullscreen (e.g. Esc).
  const buttons = [document.getElementById('fullscreen-toggle-btn'), document.getElementById('fullscreen-toggle-btn-mobile')].filter(Boolean);
  if (buttons.length === 0) return;

  function updateButton() {
    const isFullscreen = !!document.fullscreenElement;
    buttons.forEach((btn) => {
      const label = btn.querySelector('#fullscreen-toggle-label');
      if (label) label.textContent = isFullscreen ? 'Exit Full Screen View' : 'Full Screen View';
      const iconUse = btn.querySelector('use');
      if (iconUse) iconUse.setAttribute('href', isFullscreen ? '#icon-minimize' : '#icon-maximize');
      btn.setAttribute('aria-label', isFullscreen ? 'Exit Full Screen View' : 'Full Screen View');
    });
  }

  // A real request: "there should be a code request to exit full screen
  // mode" - reuses the shared Class Check-In PIN (routes/admin.js's own
  // POST /admin/fullscreen/verify-pin) so leaving full screen isn't just
  // one accidental tap/Esc away on a device left running in kiosk-style
  // full screen. The dialog markup itself lives once in partials/admin-
  // nav.ejs (alongside these buttons) rather than being built here, so
  // its styling stays with the rest of that partial's own dialogs.
  const pinDialog = document.getElementById('fullscreen-exit-pin-dialog');
  const pinForm = pinDialog ? pinDialog.querySelector('form') : null;
  const pinInput = pinDialog ? pinDialog.querySelector('#fullscreen-exit-pin-input') : null;
  const pinError = pinDialog ? pinDialog.querySelector('#fullscreen-exit-pin-error') : null;

  function requestExit() {
    if (!pinDialog) { document.exitFullscreen(); return; }
    if (pinError) pinError.hidden = true;
    if (pinInput) pinInput.value = '';
    pinDialog.showModal();
    if (pinInput) pinInput.focus();
  }

  if (pinForm) {
    pinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = pinInput ? pinInput.value.trim() : '';
      let result;
      try {
        const verifyUrl = pinDialog.dataset.verifyUrl || '/admin/fullscreen/verify-pin';
        const resp = await fetch(verifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-CSRF-Token': window.CSRF_TOKEN || '',
          },
          body: 'pin=' + encodeURIComponent(pin),
        });
        result = await resp.json();
      } catch (err) {
        result = { ok: false, error: 'Could not verify PIN. Please try again.' };
      }
      if (result.ok) {
        pinDialog.close();
        document.exitFullscreen();
      } else if (pinError) {
        pinError.textContent = result.error || 'Incorrect PIN.';
        pinError.hidden = false;
        if (pinInput) { pinInput.value = ''; pinInput.focus(); }
      }
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (document.fullscreenElement) {
        requestExit();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
  });

  document.addEventListener('fullscreenchange', updateButton);
  updateButton();
})();
