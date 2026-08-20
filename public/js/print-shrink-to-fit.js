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
  var MAX_CORRECTIONS = 40;
  var MIN_SCALE = 0.05;

  function fitOne(wrap) {
    const inner = wrap.firstElementChild;
    if (!inner) return;
    inner.style.zoom = 1;
    // [data-shrink-to-fit-budget] (e.g. "9.8in") is for a wrapper that
    // does NOT want a real, permanent CSS height of its own - unlike
    // #grid-box-attendance, which genuinely needs a fixed height all the
    // time (it's a real on-screen scroll box) - one team-per-page Setup/
    // Cleanup printing (see .team-print-page-fit in styles.css) only
    // needs a height *during this measurement*, to know how much room a
    // busy team is allowed to shrink into. Confirmed live: giving the
    // wrapper that same height permanently in the CSS (as a plain
    // `height: 9.8in`, matching #grid-box-attendance's own pattern)
    // produced a genuine extra blank page in real paginated print output
    // for a team whose content was nowhere near that tall - a fixed-
    // height block sized close to a full page, positioned via
    // page-break-before, apparently confuses Chromium's real print
    // pagination into reserving a page for "whatever comes after" even
    // when nothing does, regardless of how much of that height the
    // content actually uses. Applying the height only long enough to
    // measure against it, then handing the wrapper back to `height:
    // auto` (its own natural, content-driven size - small for a light
    // team, ~the full budget for a team that genuinely needed the room)
    // for the actual page layout fixed it: confirmed live the trailing
    // blank page was gone once this collapsed back down afterward.
    const budget = wrap.dataset.shrinkToFitBudget;
    if (budget) wrap.style.height = budget;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (budget) wrap.style.height = '';
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
    // and keep correcting until it's genuinely inside - the same
    // "don't trust the estimate, verify for real" approach public/js/
    // badge-autofit.js uses for the identical class of problem.
    //
    // getBoundingClientRect() specifically, NOT scrollWidth/scrollHeight,
    // for that real measurement - confirmed live (a real bug this became
    // once a much-larger-than-one-page case existed to expose it, see
    // below): scrollWidth/scrollHeight report the element's UNZOOMED
    // intrinsic size no matter what zoom is currently applied to it, so a
    // "correction" loop comparing THOSE against availW/availH was
    // comparing a constant against a constant every pass - it either never
    // ran (already fit) or, once the natural size was ever bigger than
    // available, could NEVER see itself as "fixed" no matter how far zoom
    // shrank the box, since that comparison never reflected the zoom at
    // all. getBoundingClientRect() is scaled by zoom exactly (confirmed:
    // a 320px-tall box at zoom 0.5 reports rect.height 160, not 320), so
    // it's the only one of the two that actually tells this loop the
    // truth about where things stand after a correction.
    //
    // A real request extended this same mechanism to a case the original
    // fixed-step version (a flat -2% nudge, up to 6 times - +/-12% total)
    // was never sized for: "printing the setup cleanup teams should be
    // one team per page[,] reduced to fit one whole team card per page" -
    // a team with many more members than remotely fit needs a MUCH bigger
    // correction than a few stray pixels of rounding drift, in one pass if
    // possible. Each correction here is PROPORTIONAL - re-derive the scale
    // from the actual post-zoom measurement each time (how far off it
    // still is, not a fixed nudge) - so a near-miss still converges in
    // essentially one extra pass same as before, while a drastically
    // undersized box (order-of-magnitude too small) converges in a handful
    // of passes instead of not converging at all. MIN_SCALE is a floor
    // against shrinking to genuinely illegible/zero size for a truly
    // extreme case (hundreds of rows) rather than looping toward 0 forever.
    for (let i = 0; i < MAX_CORRECTIONS && scale > MIN_SCALE; i++) {
      const rect = inner.getBoundingClientRect();
      if (rect.width <= availW && rect.height <= availH) break;
      const widthRatio = availW / rect.width;
      const heightRatio = availH / rect.height;
      scale = Math.max(MIN_SCALE, scale * Math.min(1, widthRatio, heightRatio));
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

  // See the big comment at the end of the setup-teams-print-page @media
  // print block in styles.css ("Confirmed live via Playwright's
  // page.pdf()...") for the full story - short version: `beforeprint` (and
  // therefore this whole measure-and-shrink pass) is confirmed to fire
  // BEFORE the browser has actually switched to the print media type in
  // Chromium's real paginated print/PDF pipeline, so measuring "as normal"
  // here sees the wrong (still-on-screen) box size/shape and freezes a
  // zoom computed against it - by the time the page truly flips to print
  // media a moment later, pagination has already been captured off that
  // wrong measurement. `.print-measuring` is a small set of plain (non-
  // @media) rules that mirror just the print-only layout changes that
  // actually affect what gets measured here - toggling it synchronously
  // around every measurement pass forces THIS pass to already see the true
  // print-time layout, instead of hoping the ambient CSS media state caught
  // up in time.
  function withPrintMeasuring(fn) {
    // On <body>, not <html> - the @media print rules this mirrors (see
    // styles.css) are keyed off page-identifying classes that live on
    // <body> (e.g. .setup-teams-print-page .admin-main), and a compound
    // selector needs both classes on the SAME element to match.
    document.body.classList.add('print-measuring');
    fn();
    document.body.classList.remove('print-measuring');
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('resize', fitAll);
  window.addEventListener('beforeprint', function () {
    fitAll();
    withPrintMeasuring(fitAllForPrint);
  });
  window.addEventListener('afterprint', resetAllForPrint);

  // Belt-and-suspenders, same reasoning as public/js/print-auto.js's own
  // matchMedia fallback: [data-shrink-to-fit-on-print] (the live
  // Attendance roster grid) ONLY ever gets its fit-to-one-page zoom
  // applied inside the beforeprint handler above - unlike plain
  // [data-shrink-to-fit], it deliberately has no load/resize fit (see
  // fitAllForPrint's own comment on why that would fight the on-screen
  // scrollbar). If beforeprint never fires (mobile browsers and some
  // embedded print flows are inconsistent about it), that shrink simply
  // never happens and a busy roster prints unshrunk, spilling rows onto
  // extra pages instead of fitting one - matchMedia('print') is a second,
  // independent way to catch the same transition.
  if (window.matchMedia) {
    const mql = window.matchMedia('print');
    const onPrintChange = (e) => { if (e.matches) { fitAll(); withPrintMeasuring(fitAllForPrint); } else { resetAllForPrint(); } };
    if (mql.addEventListener) mql.addEventListener('change', onPrintChange);
    else if (mql.addListener) mql.addListener(onPrintChange); // Safari <14
  }
})();
