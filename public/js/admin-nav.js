(function () {
  const path = window.location.pathname;

  // data-match can hold multiple comma-separated extra paths (e.g. Attendance
  // also covers /admin/absence-list and /admin/checkinout-log).
  function matchPrefixes(el, primary) {
    const extra = (el.dataset.match || '').split(',').map((s) => s.trim());
    return [primary].concat(extra);
  }

  function bestMatch(candidates, getPrefixes) {
    let best = null;
    let bestLen = -1;
    candidates.forEach((item) => {
      getPrefixes(item).forEach((prefix) => {
        if (!prefix) return;
        const matches = path === prefix || path.indexOf(prefix + '/') === 0;
        if (matches && prefix.length > bestLen) {
          best = item;
          bestLen = prefix.length;
        }
      });
    });
    return best;
  }

  // Highlight whichever link best matches the current page (longest prefix
  // match wins). A link can also claim extra paths via data-match. Desktop
  // sidebar and mobile icon tabs are two separate DOM trees (only one
  // visible at a time depending on viewport width), so each is highlighted
  // independently.
  function highlightNav(containerSelector) {
    const links = Array.prototype.slice.call(document.querySelectorAll(containerSelector + ' a'));
    const activeLink = bestMatch(links, (a) => matchPrefixes(a, a.getAttribute('href')));
    if (activeLink) activeLink.classList.add('active');
  }

  highlightNav('#admin-nav-links');
  highlightNav('#admin-mobile-tabs');
})();
