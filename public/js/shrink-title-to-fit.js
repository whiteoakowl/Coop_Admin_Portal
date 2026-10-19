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
// 'normal' through phases 1-2 (never break-word), so a word is never
// split, only ever wrapped BETWEEN words. Same proven measure-and-shrink
// loop public/js/barcode-print-shrink-name.js already uses for an
// identical class of problem (a name below a barcode).
//
// A later, more direct real bug report - "Class schedule on mobile, the
// titles are trailing off the class card. Shrink to fit." - traced to a
// case phases 1-2 alone can't solve at all: a Classes-grid card column on
// the narrowest phones measures only ~35-60px wide (4 hour columns on one
// screen), and plenty of ordinary English words ("Conversational",
// "Homeschoolers") are themselves wider than that even at the 10px floor
// font size. overflow-wrap: normal refuses to break a word mid-way no
// matter how long it is, so that ONE word (not just a single-word title -
// confirmed live: it also happens to one long word inside an otherwise
// normal multi-word title) just overflows sideways past the card's own
// edge - exactly "trailing off." Phase 3 below is the one case this
// script allows a mid-word break at all: only once phases 1-2 have
// already shrunk to the floor AND tried wrapping and the title STILL
// doesn't fit either dimension, overflow-wrap switches to 'anywhere' as a
// last resort - "don't split words" stays the preference every other
// case already relies on, but it can't come at the cost of visibly
// spilling off the card, which is what was actually reported.
// A real follow-up request: "Class name are breaking onto multiple rows.
// Words should stay together at least on a row. Shrink the font to fit" -
// a normal-width class card (not the extreme ~35-60px mobile case phase 3
// above is for) was falling into phase 2's 2-line wrap for an ordinary
// multi-word title with one longish word ("Intermediate Conversational
// Spanish") well before it actually ran out of readable font size -
// lowered from 10 so phase 1 tries harder to keep a title on its one,
// preferred line before ever wrapping it at all.
// A real follow-up request: "Words are still being split into separate
// rows. A word should stay together. Shrink more to fit if necessary" -
// on the narrowest mobile cards, phases 1-2 below used to give up at the
// normal-readability floor (MIN_FONT_SIZE_PX) and hand a still-too-wide
// single word straight to phase 3's mid-word split, even though shrinking
// it further still - well past normal readability - would often have let
// it fit intact instead. Phase 2.5 is that extra, more aggressive attempt:
// it only ever runs once a single word is still wider than the box at the
// normal floor, and only shrinks further, down to ABSOLUTE_MIN_FONT_SIZE_PX,
// trying to avoid ever reaching phase 3 at all. Phase 3 itself stays as the
// true last resort for the rare word that doesn't fit even that small.
(function () {
  var MIN_FONT_SIZE_PX = 8;
  var ABSOLUTE_MIN_FONT_SIZE_PX = 5;

  function shrinkToFit(el) {
    el.style.fontSize = ''; // back to the CSS default (already breakpoint-correct) before measuring.
    el.style.whiteSpace = 'nowrap';
    el.style.overflowWrap = ''; // back to the CSS default ('normal') - a previous pass may have set 'anywhere' (phase 3 below).
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
    // actually needs rather than one that's ever truncated.
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

    // Phase 2.5 (see this file's own top comment): with whiteSpace/display
    // already back to their normal, freely-wrapping state (either never
    // left it, if phase 1 alone was enough, or phase 2 just reset it), any
    // remaining scrollWidth > clientWidth can only mean one unbreakable
    // word is still wider than the box at every possible wrap point - not
    // a "needs a 3rd/4th line" problem, which free wrapping already
    // solves on its own. Keep shrinking that one case, past the normal
    // floor, before ever handing it to phase 3's mid-word split.
    while (el.scrollWidth > el.clientWidth && fontSize > ABSOLUTE_MIN_FONT_SIZE_PX) {
      fontSize -= 1;
      el.style.fontSize = Math.max(fontSize, ABSOLUTE_MIN_FONT_SIZE_PX) + 'px';
    }

    // Phase 3 (last resort - see this file's own top comment): the one
    // case even Phase 2.5 couldn't fix - a single word still wider than
    // the box even at ABSOLUTE_MIN_FONT_SIZE_PX. Checked last, so it only
    // ever engages for a title nothing above could fit any other way.
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) {
      el.style.overflowWrap = 'anywhere';
    }
  }

  function shrinkAll() {
    document.querySelectorAll('.class-card-header h3, .class-schedule-room-name, .grade-level-report-col-title, .grade-level-bar-label, .grade-level-report-name').forEach(shrinkToFit);
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
