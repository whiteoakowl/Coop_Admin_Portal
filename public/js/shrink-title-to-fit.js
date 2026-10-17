// Shared single-line-first, word-boundary-wrap-fallback title shrink -
// started life as class-card-title-fit.js (Classes grid: Co-op Admin's
// own Class Schedules page and the Parent Portal's Classes page, both
// rendering the exact same .class-card markup - see views/partials/
// class-schedule-grid.ejs's own comment) for a real request: "make sure
// title shrink to fit in in class colored box/card," later sharpened to
// "shrink text to fit class title words on the same row, don't split
// words. Make sure row titles shrink to fit in box." Renamed once a
// second, unrelated page (Main Admin > Members > Grade Level Report -
// its own column titles, .grade-level-report-col-title) needed the exact
// same treatment - this file has no class-schedule-specific logic left
// in it at all, just a generic "shrink this element's text to fit its
// own box" measure-and-shrink loop, so a class-schedule-only name no
// longer fit what it actually does.
//
// Every targeted element (listed in shrinkAll below) tries to shrink its
// own font-size down (never up) until it fits on ONE line - the common
// case at normal/tablet/desktop widths. On the narrowest mobile
// breakpoint (where, for the Classes grid, all 4 hour columns still have
// to fit on one phone-width screen - see styles.css's own @media
// (max-width: 480px) comment), even realistic text can run out of width
// before it runs out of readable font size; a confirmed follow-up on the
// original request chose wrapping to a 2nd line at a word boundary over
// clipping the end of the text in that case - overflow-wrap stays
// 'normal' in CSS the whole time (never break-word), so a word is never
// split, only ever wrapped BETWEEN words. Same proven measure-and-shrink
// loop public/js/barcode-print-shrink-name.js already uses for an
// identical class of problem (a name below a barcode).
(function () {
  var MIN_FONT_SIZE_PX = 10;

  function shrinkToFit(el) {
    el.style.fontSize = ''; // back to the CSS default (already breakpoint-correct) before measuring.
    el.style.whiteSpace = 'nowrap';
    var fontSize = parseFloat(getComputedStyle(el).fontSize);

    // Phase 1: shrink while trying to keep the whole title on one line -
    // scrollWidth vs clientWidth (horizontal overflow), since nowrap
    // means a title that's still too wide overflows sideways rather than
    // wrapping.
    while (el.scrollWidth > el.clientWidth && fontSize > MIN_FONT_SIZE_PX) {
      fontSize -= 1;
      el.style.fontSize = Math.max(fontSize, MIN_FONT_SIZE_PX) + 'px';
    }

    // Phase 2: still doesn't fit on one line even at the floor size (only
    // ever happens on the narrowest mobile cards) - fall back to
    // wrapping at a word boundary, capped at 2 lines, continuing to
    // shrink from here if 2 lines alone isn't enough either. The
    // TEMPORARY clamp below is only there to measure whether shrinking
    // avoids a 3rd line; it's always stripped again afterward, so the
    // worst case (an extremely long title even 2 lines at the floor size
    // can't hold) is a title that wraps across however many lines it
    // actually needs rather than one that's ever truncated or split
    // mid-word.
    if (el.scrollWidth > el.clientWidth) {
      el.style.whiteSpace = 'normal';
      el.style.display = '-webkit-box';
      el.style.webkitBoxOrient = 'vertical';
      el.style.webkitLineClamp = '2';
      while (el.scrollHeight > el.clientHeight && fontSize > MIN_FONT_SIZE_PX) {
        fontSize -= 1;
        el.style.fontSize = Math.max(fontSize, MIN_FONT_SIZE_PX) + 'px';
      }
      el.style.display = '';
      el.style.webkitBoxOrient = '';
      el.style.webkitLineClamp = '';
    }
  }

  function shrinkAll() {
    document.querySelectorAll('.class-card-header h3, .class-schedule-room-name, .grade-level-report-col-title, .grade-level-bar-label').forEach(shrinkToFit);
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
  // shrink/wrap (or newly does) gets re-measured from that new starting
  // point.
  window.addEventListener('resize', shrinkAll);
})();
