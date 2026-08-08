// Scales a print page's content down (never up) to fit the space its
// wrapper is actually given, so a busy day's Class Schedule always lands
// on one physical page instead of spilling onto a second - a plain CSS
// @page rule only sets the paper size/margins, it can't shrink content to
// match. Uses `zoom` (not `transform: scale`) specifically because zoom
// resizes the element's real layout box, which is what the print engine's
// page-break calculation actually looks at - a transform-scaled box still
// reports its original, oversized height and would still overflow onto a
// second page even though it visually looks smaller on screen.
(function () {
  function fitOne(wrap) {
    const inner = wrap.firstElementChild;
    if (!inner) return;
    inner.style.zoom = 1;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (!availW || !availH) return;
    const scale = Math.min(1, availW / inner.scrollWidth, availH / inner.scrollHeight);
    inner.style.zoom = scale;
  }

  function fitAll() {
    document.querySelectorAll('[data-shrink-to-fit]').forEach(fitOne);
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('beforeprint', fitAll);
  window.addEventListener('resize', fitAll);
})();
