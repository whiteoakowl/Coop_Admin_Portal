/* global JsBarcode */
// Barcode-only print sheet (views/admin-name-tag-barcode-print.ejs). Two
// jobs, both about keeping every barcode on the sheet visually the same
// "size" as every other one, even though names (and so barcode values -
// routes/admin-members.js sets a member's barcode to their name) vary a
// lot in length:
//
// 1. Render each barcode with a FIXED bar width (JsBarcode's `width`
//    option), not the shared public/js/name-tag-render.js's renderer this
//    page used to load. That renderer leaves JsBarcode's own natural,
//    content-length-driven SVG width in place and lets CSS stretch/
//    squash the whole SVG (viewBox and all) to a fixed box - fine for the
//    name-tag designer, where "size" means "the box I dragged this
//    element to," but wrong here: a short name's barcode (few bars)
//    getting stretched to fill the same box as a long name's (many bars,
//    squeezed thinner) makes bar thickness visibly inconsistent sheet to
//    sheet, even though every SVG's bounding box is identical. Fixing the
//    bar width instead keeps every bar the same thickness; the total
//    barcode width is left to vary with content (capped by max-width in
//    CSS so a very long name's barcode can't overflow its cell) - same as
//    any real-world barcode a longer value produces.
//
// 2. Shrink each name below its barcode - never the barcode itself, only
//    the name text - down to fit its cell (public/css/styles.css's
//    .barcode-cell-name is deliberately large, meant to be read at a
//    glance; text-overflow: ellipsis there is the static fallback if this
//    JS doesn't run).
(function () {
  var MIN_FONT_SIZE_PX = 9; // still legible; well below the 1.4rem (~22.4px) default.
  var BARCODE_MODULE_WIDTH_PX = 1.5; // narrow-bar width - fixed, same for every barcode on the sheet.

  function renderBarcode(svg) {
    var value = svg.dataset.barcodeValue;
    if (!value || typeof JsBarcode === 'undefined') return;
    try {
      JsBarcode(svg, value, {
        format: 'CODE128',
        displayValue: false,
        margin: 0,
        width: BARCODE_MODULE_WIDTH_PX,
        height: svg.clientHeight || 50,
      });
    } catch (e) {
      // Unrenderable value (e.g. empty placeholder) - leave the svg blank.
    }
  }

  function renderAllBarcodes() {
    document.querySelectorAll('.barcode-cell-svg').forEach(renderBarcode);
  }

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

  function shrinkAllNames() {
    document.querySelectorAll('.barcode-cell-name').forEach(shrinkToFit);
  }

  // Shrinking has to happen-and-finish strictly before anything is
  // measured, and a plain 'load' listener can't guarantee that on its
  // own: web fonts (partials/head.ejs, loaded with display: swap) may
  // still be swapping in when 'load' fires, and measuring/shrinking
  // against the fallback font's metrics, then having the real font swap
  // in afterward, can leave a name too big for its cell with no further
  // pass to catch it. document.fonts.ready resolves once the real fonts
  // are actually applied, so it's the one point it's safe to measure text
  // from - one pass, not a "measure early, hope a second pass corrects it
  // later" race. Barcode rendering doesn't depend on web fonts, but
  // there's no reason to render it any earlier than this same one gate.
  //
  // Unlike this file's previous version, nothing here calls
  // window.print() - see public/js/print-auto.js's own comment for why
  // pages don't auto-print anymore. The page renders and waits for the
  // visible Print button to be clicked.
  function ready(fn) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fn);
    } else {
      window.addEventListener('load', fn);
    }
  }

  ready(function () {
    renderAllBarcodes();
    shrinkAllNames();
  });

  // Defensive re-run if the sheet is printed again later (the page's own
  // manual Print button, or Ctrl/Cmd+P) - e.g. after a window resize
  // changed how much width each cell actually has. Re-rendering the
  // barcodes here is a no-op in practice (same value in, same output out)
  // but keeps both passes symmetric.
  window.addEventListener('beforeprint', function () {
    renderAllBarcodes();
    shrinkAllNames();
  });
})();
