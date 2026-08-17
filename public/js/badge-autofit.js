// Real, browser-measured shrink-to-fit correction for badge text elements
// marked autoFitText (name-tag-render-core.js's renderTextEl, which
// server-side-renders a FAST character-width estimate for the initial
// paint - see fitFontSize's own comment on why that's only ever a
// starting guess). A live bug report: a name tag's Name field ("Jessica
// Adema", "Carson Bellingham", ...) kept getting clipped on both the
// design editor's live preview AND the actual printed tag, even after
// that estimate looked like it should have fit - the estimate doesn't
// know the exact font/weight/kerning a real browser will actually render
// (the site's own webfont, not the generic sans-serif the character-width
// ratios were tuned against), so it can under-shrink. renderTextEl now
// forces autoFitText onto a single line (white-space: nowrap) instead of
// letting a too-wide estimate wrap and get silently clipped by the
// element's fixed-height overflow:hidden - this script is what actually
// catches "wait, that still doesn't fit" and shrinks further, using the
// same real-DOM-measurement shrinkToFit pattern already proven for the
// barcode-only print sheet (see barcode-print-shrink-name.js) - with two
// corrections that pattern didn't need, found chasing this same bug:
//
//   1. That file resets font-size to '' before measuring, falling back to
//      an actual CSS class default (.barcode-cell-name's own font-size
//      rule). badge-el-text-inner has no such class rule - its font-size
//      only ever comes from the inline style renderTextEl writes - so
//      resetting to '' here falls back to nothing useful (whatever
//      ambient/inherited font-size happens to apply), not the value
//      fitFontSize actually computed. renderTextEl now stamps that value
//      onto data-base-font-size specifically so this always has a real
//      value to reset to and re-search from - important because a re-run
//      (e.g. after a resize gave the box more room) needs to be able to
//      grow back up, not just shrink from wherever it last landed.
//   2. badge-el-text is `display:flex` (for align-items-based vertical
//      centering), which makes badge-el-text-inner a flex item - and a
//      flex item's default min-width is its own content size, not 0, so
//      the browser can silently shrink it to fit the flex container
//      WITHOUT that ever registering as scrollWidth > clientWidth on the
//      item itself (confirmed live: a shrunk allergy note measured as
//      "fits perfectly" by that comparison while visibly still ending in
//      a clipped "…"). measureNaturalWidth below takes the element out of
//      flex sizing entirely (position: absolute) before measuring, so its
//      width reflects its actual content, not whatever the flex algorithm
//      already resized it to.
//
// Runs on both the design editor's live canvas (public/js/name-tag-
// editor.js and schedule-card-editor.js call window.runBadgeAutoFit after
// every re-render) and every print/preview page that includes this
// script - the same shared rendering module backs both, so this keeps
// "what you design is what prints" true for real instead of only true by
// the server's own estimate.
(function () {
  var MIN_FONT_SIZE_PX = 6;
  var STEP_PX = 0.5;

  // Measures inner's true, unconstrained content width - taking it out of
  // its flex-item sizing for the moment (see this file's header comment,
  // point 2) so the result reflects what the text actually needs, not
  // whatever width the flex container already resized it to.
  function measureNaturalWidth(inner) {
    var prevPosition = inner.style.position;
    var prevWidth = inner.style.width;
    var prevLeft = inner.style.left;
    inner.style.position = 'absolute';
    inner.style.left = '-9999px';
    inner.style.width = 'auto';
    var width = inner.scrollWidth;
    inner.style.position = prevPosition;
    inner.style.width = prevWidth;
    inner.style.left = prevLeft;
    return width;
  }

  function shrinkToFit(box) {
    var inner = box.querySelector('.badge-el-text-inner');
    if (!inner) return;
    var baseFontSize = parseFloat(box.dataset.baseFontSize);
    if (isNaN(baseFontSize)) baseFontSize = parseFloat(getComputedStyle(inner).fontSize);
    var fontSize = baseFontSize;
    inner.style.fontSize = fontSize + 'px';
    var available = box.clientWidth;
    // >= rather than > on purpose: even measureNaturalWidth's more
    // reliable reading is still an integer-rounded scrollWidth, so a
    // genuine "a fraction of a pixel still sticking out" case can round
    // down to reporting the two as equal - text-overflow: ellipsis still
    // visually triggers on that real, if sub-pixel, overflow. Treating
    // "reported equal" as "not confirmed to fit yet" costs at most one
    // extra half-pixel of shrink on a genuinely-exact fit, which is
    // imperceptible - far cheaper than a badge that silently truncates.
    while (measureNaturalWidth(inner) >= available && fontSize > MIN_FONT_SIZE_PX) {
      fontSize -= STEP_PX;
      inner.style.fontSize = fontSize + 'px';
    }
  }

  function runBadgeAutoFit(root) {
    (root || document).querySelectorAll('[data-autofit="1"]').forEach(shrinkToFit);
  }

  window.runBadgeAutoFit = runBadgeAutoFit;

  // See barcode-print-shrink-name.js's identical comment: document.fonts.ready
  // is the one point it's safe to measure real text width from - a plain
  // 'load' listener can fire before a display:swap webfont has actually
  // swapped in, measuring against fallback-font metrics that a later font
  // swap could invalidate with no second pass to catch it.
  function ready(fn) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fn);
    } else {
      window.addEventListener('load', fn);
    }
  }

  ready(function () { runBadgeAutoFit(document); });
  // Defensive re-run for the same reason barcode-print-shrink-name.js
  // re-runs on beforeprint - e.g. a window resize between page load and
  // hitting Print/Ctrl+P.
  window.addEventListener('beforeprint', function () { runBadgeAutoFit(document); });
})();
