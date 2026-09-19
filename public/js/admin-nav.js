(function () {
  const path = window.location.pathname;

  // data-match can hold multiple comma-separated extra paths (e.g. Attendance
  // also covers /admin/absence-list and /admin/checkinout-log).
  function matchPrefixes(el, primary) {
    const extra = (el.dataset.match || '').split(',').map((s) => s.trim());
    return [primary].concat(extra);
  }

  // A mobile bottom-bar item with subpages is a <button data-subpages-
  // dialog data-href="..."> (see page-tabs.js), not an <a href="...">, so
  // it needs its own "what page does this item represent" primary path
  // instead of .getAttribute('href') (buttons have none).
  function primaryPathOf(el) {
    return el.tagName === 'A' ? el.getAttribute('href') : el.dataset.href;
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
    // .admin-nav-subpages links (views/partials/portal-nav.ejs's own
    // .admin-nav-group subpage lists) and .page-tabs-dialog links (the
    // mobile popup equivalent, mobile-subpages-tab.ejs - nested right
    // inside #admin-mobile-tabs alongside its own trigger button) both
    // carry their own ?tab= query-param semantics that plain
    // pathname-prefix matching can't tell apart - e.g. Members' bare href
    // and its own Approvals subpage's href share the exact same pathname,
    // so this generic matcher would wrongly mark the bare "default tab"
    // link active even while on Approvals. public/js/admin-nav-
    // accordion.js already highlights those correctly on its own; this
    // only needs to leave them alone.
    const links = Array.prototype.slice.call(document.querySelectorAll(containerSelector + ' a, ' + containerSelector + ' button[data-subpages-dialog]')).filter((a) => !a.closest('.admin-nav-subpages') && !a.closest('.page-tabs-dialog'));
    const activeLink = bestMatch(links, (a) => matchPrefixes(a, primaryPathOf(a)));
    if (activeLink) activeLink.classList.add('active');
  }

  highlightNav('#admin-nav-links');
  // Only present on views/partials/portal-nav.ejs's pages (Parent/Teacher/
  // Student/Main Admin) - a no-op here on admin-nav.ejs's own Co-op Admin
  // Portal pages, which have no element with these ids at all.
  highlightNav('#class-nav-links');
  highlightNav('#community-nav-links');
  highlightNav('#admin-mobile-tabs');
})();
