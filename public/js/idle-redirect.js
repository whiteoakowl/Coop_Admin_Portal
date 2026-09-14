// Sends an idle viewer (e.g. a wall-mounted volunteer schedule screen) back
// to the kiosk landing screen after a period of no interaction.
(function () {
  const timeoutMs = parseInt(document.body.dataset.idleRedirect, 10);
  if (!timeoutMs) return;

  let timer;
  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // window.fullscreenNavigate (public/js/fullscreen-nav.js, loaded
      // after this script on every page that uses data-idle-redirect)
      // swaps content in place instead of doing a real navigation while
      // in fullscreen kiosk mode, so a timeout doesn't kick the viewer
      // out of it - see that file's own comment for why a plain
      // window.location.href assignment here would.
      window.fullscreenNavigate('/kiosk');
    }, timeoutMs);
  }

  ['click', 'touchstart', 'scroll', 'mousemove', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, reset, { passive: true });
  });
  reset();
})();
