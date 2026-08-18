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

  function resetOne(wrap) {
    const inner = wrap.firstElementChild;
    if (inner) inner.style.zoom = 1;
  }

  function fitAll() {
    document.querySelectorAll('[data-shrink-to-fit]').forEach(fitOne);
  }

  // A [data-shrink-to-fit-on-print] wrapper lives on an otherwise ordinary,
  // interactively-used page (e.g. the live Attendance roster grid, which
  // needs its own horizontal scrollbar on screen for a wide date range) -
  // unlike [data-shrink-to-fit] above, which only ever appears on a
  // dedicated print-preview page where "shaped like one physical page" IS
  // the on-screen look too. Fitting it on 'load'/'resize' the way that one
  // does would fight the on-screen scrollbar: the wrapper's clientWidth is
  // *supposed* to be narrower than the table's real scrollWidth on screen
  // (that's what makes the scrollbar necessary), so fitOne would zoom the
  // whole interactive grid out to "fix" something that was never actually
  // a problem. Scoped tightly to the beforeprint/afterprint pair instead -
  // the CSS that gives the wrapper a real, bounded height/width in the
  // first place is itself scoped to @media print, so outside of an actual
  // print pass it's never a meaningfully bounded box to shrink into, and
  // afterprint zooms back out so a cancelled print dialog doesn't leave
  // the on-screen page looking shrunk.
  function fitAllForPrint() {
    document.querySelectorAll('[data-shrink-to-fit-on-print]').forEach(fitOne);
  }
  function resetAllForPrint() {
    document.querySelectorAll('[data-shrink-to-fit-on-print]').forEach(resetOne);
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('resize', fitAll);
  window.addEventListener('beforeprint', function () {
    fitAll();
    fitAllForPrint();
  });
  window.addEventListener('afterprint', resetAllForPrint);
})();
