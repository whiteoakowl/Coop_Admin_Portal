// Every dedicated print-preview page (reached by clicking a "Print"
// button/link elsewhere in the app, or by loading into the Design/Print
// hub's preview iframe after "Print Selected") used to jump straight to
// the OS print dialog as soon as it loaded. That skipped the whole point
// of a preview page - the print dialog (and, once dismissed, the browser
// window behind it) covered the preview before there was any real chance
// to look it over. The page just renders and waits for the visible Print
// button (already in every preview page's markup) to be clicked - the
// auto-print behavior this replaced is gone; see git history if it's ever
// needed again.
//
// A real bug report, reproduced from a mobile screenshot: .badge-sheet-
// page/.print-page/.avery-label-sheet-page are built to physical paper
// dimensions (a fixed 8.5in-wide on-screen box - see styles.css) so the
// preview looks like an actual sheet of paper. On a phone-width screen
// that's wider than the viewport itself, so the sheet just bled off the
// right edge instead of shrinking to fit - a bulk sheet's whole grid of
// cards extended past the visible screen with no obvious way to tell
// there was more off to the side. Shrinks each page down (never up) to
// whatever width is actually available on screen - the same "zoom
// resizes the real layout box, not just how it looks" approach public/js/
// print-shrink-to-fit.js uses, for the different problem of fitting
// variable content onto one physical page; this one is purely about the
// on-screen mobile/narrow-window viewport, so it only runs from
// load/resize and un-zooms for the actual print pass - @media print
// already gives these classes their real, unshrunk physical size (see
// styles.css), and printing through a leftover screen-fit zoom would
// print everything shrunk too.
//
// A real bug report: "this issue happens for all printing of name tags,
// schedule cards etc. as well" - the exact same zoom-unsupported-browser
// gap print-shrink-to-fit.js's own fix closes (see that file's much
// longer comment on it) existed here too, completely independently: this
// file backs the on-screen preview shrink for EVERY one of those pages
// (anything with .badge-sheet-page/.print-page/.avery-label-sheet-page -
// Name Tags, Schedule Cards, Class Schedule, Setup/Cleanup Teams, barcode
// sheets, all of it), and used the same proprietary `zoom` property with
// no fallback at all. On any browser that genuinely doesn't support zoom
// (older Firefox, before version 126/May 2024), every page.style.zoom =
// scale line below was a silent no-op - the exact mobile-bleeds-off-
// screen bug this file exists to fix in the first place, just for a
// different slice of browsers than the ones it was originally written
// against. ZOOM_SUPPORTED feature-detects this once at load; a browser
// that supports zoom (the overwhelming majority) runs through the exact
// same .style.zoom = path, completely unchanged - only a browser that
// genuinely can't do zoom falls through to transform: scale() instead.
// Unlike print-shrink-to-fit.js's own fallback, this doesn't also try to
// collapse the element's own reserved layout space to match (no second
// "wrap" element to resize here - `page` IS both the thing being scaled
// and the thing sized by its own CSS) - worst case on a zoom-unsupported
// browser is some extra blank space trailing a shrunk preview, a one-time
// on-screen cosmetic (never printed - @media print always resets to a
// real, unshrunk page first) that's a strict improvement over the
// content bleeding off-screen unreadable, not a regression against it.
(function () {
  var ZOOM_SUPPORTED = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('zoom', '1');

  function applyPageScale(page, scale) {
    if (ZOOM_SUPPORTED) {
      page.style.zoom = scale;
      return;
    }
    page.style.transform = scale === 1 ? '' : 'scale(' + scale + ')';
    page.style.transformOrigin = 'top left';
  }

  function fitOne(page) {
    applyPageScale(page, 1);
    const wrap = page.parentElement;
    if (!wrap) return;
    const available = wrap.clientWidth;
    if (!available) return;
    const scale = Math.min(1, available / page.scrollWidth);
    applyPageScale(page, scale);
  }

  function fitAll() {
    document.querySelectorAll('.badge-sheet-page, .print-page, .avery-label-sheet-page').forEach(fitOne);
  }

  function resetAll() {
    document.querySelectorAll('.badge-sheet-page, .print-page, .avery-label-sheet-page').forEach((page) => applyPageScale(page, 1));
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('resize', fitAll);
  window.addEventListener('beforeprint', resetAll);
  window.addEventListener('afterprint', fitAll);

  // Belt-and-suspenders for a real bug report ("its all drifting off the
  // pages... mobile and desktop"): beforeprint/afterprint are the normal
  // way to know a print pass is starting/ending, but mobile browsers (and
  // some embedded/in-app print flows) are inconsistent about firing them
  // at all - when they don't, the on-screen shrink zoom never gets reset
  // and leaks straight into the real printout (see styles.css's own
  // `@media print { .badge-sheet-page, .print-page { zoom: 1 !important }
  // }`, the hard CSS floor that's the real fix for that). matchMedia
  // 'print' is a second, independent signal for the same transition that
  // some browsers support even where beforeprint is flaky - listening to
  // both maximizes the chance at least one actually fires. Guarded
  // (matchMedia may not exist in a very old browser) and harmless to run
  // redundantly alongside beforeprint/afterprint - resetAll/fitAll are
  // idempotent.
  if (window.matchMedia) {
    const mql = window.matchMedia('print');
    const onPrintChange = (e) => { if (e.matches) resetAll(); else fitAll(); };
    if (mql.addEventListener) mql.addEventListener('change', onPrintChange);
    else if (mql.addListener) mql.addListener(onPrintChange); // Safari <14
  }
})();
