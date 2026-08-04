(function () {
  const btn = document.getElementById('fullscreen-toggle-btn');
  if (!btn) return;

  const label = document.getElementById('fullscreen-toggle-label');
  const iconUse = btn.querySelector('use');

  function updateButton() {
    const isFullscreen = !!document.fullscreenElement;
    if (label) label.textContent = isFullscreen ? 'Exit Full Screen View' : 'Full Screen View';
    if (iconUse) iconUse.setAttribute('href', isFullscreen ? '#icon-minimize' : '#icon-maximize');
  }

  btn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', updateButton);
  updateButton();
})();
