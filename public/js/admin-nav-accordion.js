// Desktop sidebar (views/partials/portal-nav.ejs's #admin-nav-links):
// a real request - "instead of the tabs on each page, make them subpages
// under each menu tab. When you click the menu tab the sub pages
// selection expands. If you click on another menu tab, the previous tab
// of sub pages closes. Only one tab of sub pages open at a time." Each
// .admin-nav-group is a plain <details>/<summary> (same expand/collapse
// element the sidebar's own Settings/Switch Portal accordions already
// use) - this only adds the "close every other one" exclusivity on top,
// plus opening + highlighting whichever group/subpage matches the
// current URL on load so the active section doesn't collapse itself away
// on every navigation.
//
// Mobile bottom bar: a later real request - "the tab should not work on
// mobile until you click the subpage" - moved this exact same subpages
// list into a <dialog class="page-tabs-dialog"> in the nav shell itself,
// opened by a <button data-subpages-dialog> in the orange bar (see
// public/js/page-tabs.js) instead of only ever living inside a
// <details>. Marking which .view-tab is "active" inside one of those
// dialogs is the exact same question as marking one inside a sidebar
// group, so both share the one matcher below.
(function () {
  function urlOf(href) {
    return new URL(href, window.location.origin);
  }

  // A subpage's own href carries whatever query param(s) its page expects
  // to tell it apart from its siblings - ?tab=archive, ?tab=approvals,
  // Co-op Admin Members' own ?archived=1, etc. (or none at all for a
  // group's default subpage - see portal-nav.ejs's own comment on
  // MAIN_ADMIN_NAV_LINKS for why). Matching pathname AND every query
  // param the link itself specifies - not just a hardcoded ?tab= - is
  // what tells "Members" apart from "Members > Archived" regardless of
  // which query key a given section happens to use; unrelated params
  // present on the current URL (a search/filter, a page number) are
  // simply ignored, same as this always did for ?tab=.
  function findActiveLink(links) {
    const here = new URL(window.location.href);
    let best = null;
    let bestCount = -1;
    links.forEach((a) => {
      const url = urlOf(a.getAttribute('href'));
      if (url.pathname !== here.pathname) return;
      const params = Array.prototype.slice.call(url.searchParams.entries());
      const isMatch = params.every(([k, v]) => here.searchParams.get(k) === v);
      if (!isMatch || !params.length) return;
      if (params.length > bestCount) {
        best = a;
        bestCount = params.length;
      }
    });
    if (best) return best;
    // No sibling's own query param matched - fall back to this group's
    // bare/default link (the one with no query params at all), if its
    // pathname matches the current page.
    return links.find((a) => {
      const url = urlOf(a.getAttribute('href'));
      return url.pathname === here.pathname && !url.search;
    }) || null;
  }

  const groups = Array.prototype.slice.call(document.querySelectorAll('.admin-nav-group'));
  groups.forEach((details) => {
    const links = Array.prototype.slice.call(details.querySelectorAll('.admin-nav-subpages a'));
    const matched = findActiveLink(links);
    if (matched) {
      matched.classList.add('active');
      details.open = true;
      details.classList.add('has-active-subpage');
    }
  });

  if (groups.length) {
    groups.forEach((details) => {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        groups.forEach((other) => {
          if (other !== details) other.open = false;
        });
      });
    });
  }

  // Same active-subpage highlighting, just for the mobile nav-shell
  // dialogs instead of the desktop <details> groups above - no open/
  // exclusivity behavior needed here, a <dialog> is already its own
  // overlay, closed until its own bottom-bar button opens it.
  document.querySelectorAll('.page-tabs-dialog[id^="mobile-subpages-"]').forEach((dialog) => {
    const links = Array.prototype.slice.call(dialog.querySelectorAll('.view-tab'));
    const matched = findActiveLink(links);
    if (matched) matched.classList.add('active');
  });
})();
