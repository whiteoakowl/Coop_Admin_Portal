// Sends an idle viewer (e.g. a wall-mounted volunteer schedule screen) back
// to the kiosk landing screen after a period of no interaction.
(function () {
  const timeoutMs = parseInt(document.body.dataset.idleRedirect, 10);
  if (!timeoutMs) return;

  let timer;
  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      window.location.href = '/kiosk';
    }, timeoutMs);
  }

  ['click', 'touchstart', 'scroll', 'mousemove', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, reset, { passive: true });
  });
  reset();
})();
