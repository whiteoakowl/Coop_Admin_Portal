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
(function () {
  const groups = Array.prototype.slice.call(document.querySelectorAll('.admin-nav-group'));
  if (!groups.length) return;

  const curTab = new URLSearchParams(window.location.search).get('tab');
  groups.forEach((details) => {
    const links = Array.prototype.slice.call(details.querySelectorAll('.admin-nav-subpages a'));
    // A subpage's own href carries whatever ?tab= value its page expects
    // (or none at all for the default tab - see portal-nav.ejs's own
    // comment on MAIN_ADMIN_NAV_LINKS for why), so matching both the
    // pathname AND that query param is what tells apart "Members" from
    // "Members > Approvals", not just this group's own top-level path.
    const matched = links.find((a) => {
      const url = new URL(a.getAttribute('href'), window.location.origin);
      return url.pathname === window.location.pathname && url.searchParams.get('tab') === curTab;
    });
    if (matched) {
      matched.classList.add('active');
      details.open = true;
      details.classList.add('has-active-subpage');
    }
  });

  groups.forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      groups.forEach((other) => {
        if (other !== details) other.open = false;
      });
    });
  });
})();
