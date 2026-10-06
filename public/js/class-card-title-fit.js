// Classes grid (Co-op Admin's own Class Schedules page, and the Parent
// Portal's Classes page - both render the exact same .class-card markup,
// see views/partials/class-schedule-grid.ejs's own comment) - a real
// request: "make sure title shrink to fit in in class colored box/card."
// public/css/styles.css's own .class-card-header h3 rule caps the title
// at 2 lines (-webkit-line-clamp: 2) with its own ellipsis as the static
// no-JS fallback; this shrinks the font-size down first so a long title
// reads smaller instead of hitting that clamp and losing text to "...".
// scrollHeight vs clientHeight (not width) because the clamp box's
// overflow is vertical - once a title needs more than 2 lines at the
// current size, the clamped box's own fixed height is what stops
// growing, while scrollHeight keeps reporting how tall it would be
// unclamped. Same proven measure-and-shrink loop public/js/barcode-
// print-shrink-name.js already uses for an identical class of problem
// (a name below a barcode).
(function () {
  var MIN_FONT_SIZE_PX = 10;

  function shrinkToFit(el) {
    el.style.fontSize = ''; // back to the CSS default (already breakpoint-correct) before measuring.
    var fontSize = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollHeight > el.clientHeight && fontSize > MIN_FONT_SIZE_PX) {
      fontSize -= 1;
      el.style.fontSize = fontSize + 'px';
    }
  }

  function shrinkAll() {
    document.querySelectorAll('.class-card-header h3').forEach(shrinkToFit);
  }

  // document.fonts.ready, not a plain 'load' listener - same reasoning as
  // barcode-print-shrink-name.js's own comment: measuring against a
  // fallback font's metrics before the real web font swaps in can leave a
  // title sized for the wrong font, with no second pass to catch it.
  function ready(fn) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fn);
    } else {
      window.addEventListener('load', fn);
    }
  }

  ready(shrinkAll);
  // A resize can cross one of this page's own mobile breakpoints (see
  // styles.css), which changes the CSS default font-size a card's title
  // starts shrinking from - re-run so a title that no longer needs to
  // shrink (or newly does) gets re-measured from that new starting point.
  window.addEventListener('resize', shrinkAll);
})();
