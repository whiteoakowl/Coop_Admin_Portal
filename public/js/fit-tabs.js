// Every .view-tabs strip (Members, Setup/Cleanup, Floater Assignments,
// Schedules, Logs, ...) always shows every tab on one line - instead of
// scrolling sideways to see a tab that doesn't fit, the tabs' font size
// (and padding, proportionally) shrinks just enough for the whole row to
// fit the available width.
(function () {
  function fit(row) {
    const tabs = row.querySelectorAll('.view-tab');
    if (tabs.length === 0) return;

    // Reset to the CSS defaults before measuring, so a window resize back
    // up re-expands the tabs instead of staying shrunk forever.
    tabs.forEach((t) => {
      t.style.fontSize = '';
      t.style.paddingLeft = '';
      t.style.paddingRight = '';
    });
    row.style.gap = '';
    if (row.scrollWidth <= row.clientWidth + 1) return;

    const sample = tabs[0];
    const baseFont = parseFloat(getComputedStyle(sample).fontSize);
    const basePadLeft = parseFloat(getComputedStyle(sample).paddingLeft);
    const basePadRight = parseFloat(getComputedStyle(sample).paddingRight);
    const baseGap = parseFloat(getComputedStyle(row).columnGap || getComputedStyle(row).gap) || 0;

    // Font/padding shrink first (down to a still-legible floor); a phone
    // with several long tab labels (e.g. "Class Cancellation Risk" next
    // to 3 others) can still be short on room even at that floor, so the
    // gap between tabs shrinks too as a second pass rather than leaving
    // the row to scroll sideways.
    let ratio = 1;
    let guard = 0;
    while (row.scrollWidth > row.clientWidth + 1 && ratio > 0.5 && guard < 30) {
      ratio -= 0.03;
      tabs.forEach((t) => {
        t.style.fontSize = baseFont * ratio + 'px';
        t.style.paddingLeft = basePadLeft * ratio + 'px';
        t.style.paddingRight = basePadRight * ratio + 'px';
      });
      guard++;
    }
    let gapRatio = 1;
    guard = 0;
    while (row.scrollWidth > row.clientWidth + 1 && gapRatio > 0 && guard < 20) {
      gapRatio = Math.max(0, gapRatio - 0.1);
      row.style.gap = baseGap * gapRatio + 'px';
      guard++;
    }
  }

  function fitAll() {
    document.querySelectorAll('.view-tabs').forEach(fit);
  }

  window.addEventListener('load', fitAll);
  window.addEventListener('resize', fitAll);
  document.addEventListener('fullscreenchange', () => setTimeout(fitAll, 50));
})();
