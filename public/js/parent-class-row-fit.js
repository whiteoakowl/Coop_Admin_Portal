// Parent Portal's class registration popup (views/parent-class-fragment.
// ejs) - a real request: "shrink to fit on mobile view. Make sure each
// member's name, registered bubble and button all fit clean on one row."
// .parent-class-child-name's own flex-wrap: wrap (styles.css) already
// lets a status badge ("Registered"/"Waitlisted (#2)"/etc.) drop onto its
// own line under the name instead of fracturing the name mid-word when
// both don't fit side by side at the current font size - but "own line"
// still isn't "one row" when there's a long badge next to a long name on
// a narrow phone. This shrinks the name pill's font-size first so there's
// more often room for the badge to stay right next to the name after
// all, same measure-and-shrink loop public/js/class-card-title-fit.js
// already uses for an identical class of problem (a title that needs to
// fit without breaking words).
(function () {
  var MIN_FONT_SIZE_PX = 10;

  // scrollHeight vs clientHeight (class-card-title-fit.js's own trick)
  // only detects overflow against a FIXED height - this pill has none,
  // it just grows to fit whatever wraps. Comparing the badge's own
  // offsetTop against the name text's instead directly answers "are they
  // still on the same line" regardless of how tall the pill itself ends
  // up: a wrapped badge sits measurably lower than the name beside it.
  function badgeWrapped(pill) {
    var nameText = pill.querySelector('.parent-class-child-name-text');
    var badge = pill.querySelector('.badge-pill');
    if (!nameText || !badge) return false;
    return badge.offsetTop - nameText.offsetTop > 2;
  }

  function shrinkToFit(pill) {
    pill.style.fontSize = ''; // back to the CSS default (already breakpoint-correct) before measuring.
    var fontSize = parseFloat(getComputedStyle(pill).fontSize);
    while (badgeWrapped(pill) && fontSize > MIN_FONT_SIZE_PX) {
      fontSize -= 1;
      pill.style.fontSize = fontSize + 'px';
    }
    // Hitting the floor and still wrapped just means there genuinely
    // isn't room (a very long name + a very long badge on a very narrow
    // screen) - the badge stays on its own line rather than shrinking the
    // text down to illegible, same "grow instead of lose information"
    // fallback the rest of this box already relies on.
  }

  function shrinkAll() {
    document.querySelectorAll('.class-view-register-box .parent-class-child-name').forEach(shrinkToFit);
  }

  // document.fonts.ready - same reasoning as class-card-title-fit.js's
  // own comment: measuring against a fallback font's metrics before the
  // real web font swaps in can leave a pill sized for the wrong font.
  function ready(fn) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fn);
    } else {
      window.addEventListener('load', fn);
    }
  }

  ready(shrinkAll);
  // This popup is a fragment fetched into a <dialog> well after page
  // load (public/js/fragment-dialog.js) - its own synthetic 'resize'
  // dispatch right after injecting the fragment's HTML is what re-runs
  // this on every fresh class popup, not just the page's own initial
  // load. Also covers a real browser resize/breakpoint crossing, same as
  // class-card-title-fit.js.
  window.addEventListener('resize', shrinkAll);
})();
