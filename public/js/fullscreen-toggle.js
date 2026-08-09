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

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
  });

  document.addEventListener('fullscreenchange', updateButton);
  updateButton();
})();
