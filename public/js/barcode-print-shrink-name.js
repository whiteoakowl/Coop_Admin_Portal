// Barcode-only print sheet (views/admin-name-tag-barcode-print.ejs):
// .barcode-cell-name is deliberately large (public/css/styles.css - meant
// to be read at a glance, not squinted at), which means a longer name can
// overflow its cell at that size. Rather than let CSS's text-overflow:
// ellipsis (the static fallback, still in place if this JS doesn't run)
// silently cut a name off, shrink that one name's font down - never up,
// and never the barcode itself, only the name text - until it fits on
// its one line, so every name on the sheet stays fully readable at the
// largest size that actually fits its own cell.
(function () {
  var MIN_FONT_SIZE_PX = 9; // still legible; well below the 1.4rem (~22.4px) default.

  function shrinkToFit(el) {
    el.style.fontSize = ''; // back to the CSS default before measuring.
    var fontSize = parseFloat(getComputedStyle(el).fontSize);
    // scrollWidth/clientWidth are both rounded to whole pixels, so a "+1
    // pixel of slack" tolerance here doesn't mean "1px of true overflow is
    // fine" - it can mask real (if sub-pixel) overflow that text-overflow:
    // ellipsis still visually triggers on. No tolerance: shrink until
    // scrollWidth truly stops exceeding clientWidth.
    // scrollWidth vs clientWidth needs white-space: nowrap (already set in
    // CSS) to mean anything - a wrapping element's scrollWidth just equals
    // its clientWidth regardless of overflow.
    while (el.scrollWidth > el.clientWidth && fontSize > MIN_FONT_SIZE_PX) {
      fontSize -= 1;
      el.style.fontSize = fontSize + 'px';
    }
  }

  function shrinkAll() {
    document.querySelectorAll('.barcode-cell-name').forEach(shrinkToFit);
  }

  // This page skips the generic public/js/print-auto.js (every other
  // print-preview page uses it) and triggers window.print() itself below
  // instead - shrinking has to happen-and-finish strictly before print
  // fires, and a plain 'load' listener can't guarantee that on its own:
  // web fonts (partials/head.ejs, loaded with display: swap) may still be
  // swapping in when 'load' fires, and measuring/shrinking against the
  // fallback font's metrics, then having the real font swap in afterward,
  // can leave a name too big for its cell with no further pass to catch
  // it. document.fonts.ready resolves once the real fonts are actually
  // applied, so it's the one point it's safe to measure from - one pass,
  // not a "measure early, hope a second pass corrects it later" race.
  function ready(fn) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fn);
    } else {
      window.addEventListener('load', fn);
    }
  }

  ready(function () {
    shrinkAll();
    window.print();
  });

  // Defensive re-shrink if the sheet is printed again later (the page's
  // own manual Print button, or Ctrl/Cmd+P) - e.g. after a window resize
  // changed how much width each cell actually has.
  window.addEventListener('beforeprint', shrinkAll);
})();
