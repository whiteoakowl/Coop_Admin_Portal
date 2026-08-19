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
(function () {
  function fitOne(page) {
    page.style.zoom = 1;
    const wrap = page.parentElement;
    if (!wrap) return;
    const available = wrap.clientWidth;
    if (!available) return;
    const scale = Math.min(1, available / page.scrollWidth);
    page.style.zoom = scale;
  }

  function fitAll() {
    document.querySelectorAll('.badge-sheet-page, .print-page, .avery-label-sheet-page').forEach(fitOne);
  }

  function resetAll() {
    document.querySelectorAll('.badge-sheet-page, .print-page, .avery-label-sheet-page').forEach((page) => { page.style.zoom = 1; });
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
