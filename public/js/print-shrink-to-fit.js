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
  var MAX_CORRECTIONS = 6;
  var CORRECTION_STEP = 0.02;

  function fitOne(wrap) {
    const inner = wrap.firstElementChild;
    if (!inner) return;
    inner.style.zoom = 1;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (!availW || !availH) return;
    let scale = Math.min(1, availW / inner.scrollWidth, availH / inner.scrollHeight);
    inner.style.zoom = scale;
    // The ratio above is computed from the UNSCALED box, then applied in
    // one shot - fine for most content, but a table with many rows can
    // drift a few real pixels off that estimate (border/padding rounding
    // compounding row over row isn't exactly linear with zoom), landing
    // the last row or two just outside `wrap` after all - confirmed live:
    // a 25-row class roster's very last row sat ~7px past the wrapper's
    // own bottom edge even though the computed scale looked right. Rather
    // than trust the one estimate, re-measure the ACTUAL post-zoom box
    // and keep nudging down until it's genuinely inside - the same
    // "don't trust the estimate, verify for real" approach public/js/
    // badge-autofit.js uses for the identical class of problem.
    for (let i = 0; i < MAX_CORRECTIONS && scale > 0 && (inner.scrollWidth > availW || inner.scrollHeight > availH); i++) {
      scale = Math.max(0, scale - CORRECTION_STEP);
      inner.style.zoom = scale;
    }
  }

  function fitAll() {
    document.querySelectorAll('[data-shrink-to-fit]').forEach(fitOne);
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('beforeprint', fitAll);
  window.addEventListener('resize', fitAll);
})();
