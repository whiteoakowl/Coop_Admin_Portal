// A real request: "mobile view instead of tabs on all the pages. when
// you click the tab below a menu will pop up showing the different page
// choices." Each converted page keeps its own existing .view-tab links
// (the exact same ones admin-nav-accordion.js's sidebar subpages read
// their labels/hrefs from) unchanged, just moved inside a <dialog
// class="page-tabs-dialog"> instead of an inline strip.
//
// A later real request: "no blue menu page bar on the pages. Only the
// pop up on the orange bar to choose a subpage" - the visible
// .page-tabs-trigger button (a blue bar inline in the page content) is
// gone (styles.css keeps it in the DOM, permanently display: none, just
// so this script still has a stable "previousElementSibling" way to
// find which dialog belongs to the current page). The popup now opens
// from tapping the bottom orange bar's OWN current tab instead - the
// one admin-nav.js already marked .active for this page - so there's
// nothing new to tap, just a repurposed click on the icon you're
// already on.
(function () {
  // This script loads from views/partials/portal-nav.ejs, which is
  // included near the TOP of <body> - well before the <main> content
  // (and this dialog/trigger pair inside it) further down the same
  // document has even been parsed yet. A plain immediate run would find
  // zero .page-tabs-dialog elements and silently wire up nothing (same
  // reasoning as public/js/roster-btn-row-grid.js's own 'load' listener,
  // whose target markup has this same problem).
  function wire() {
    document.querySelectorAll('.page-tabs-dialog').forEach((dialog) => {
      const trigger = dialog.previousElementSibling;
      if (!trigger || !trigger.classList.contains('page-tabs-trigger')) return;
      const activeTab = dialog.querySelector('.view-tab.active');
      const label = trigger.querySelector('.page-tabs-trigger-label');
      if (activeTab && label) label.textContent = activeTab.textContent.trim();
      trigger.addEventListener('click', () => dialog.showModal());

      // admin-nav.js runs synchronously, before this deferred 'load'
      // wiring, and only ever marks ONE #admin-mobile-tabs link .active
      // (the one matching the current page) - that's the tab a phone
      // user is already looking at, so tapping it again opens this
      // page's own subpages instead of just reloading the same page.
      const activeBottomTab = document.querySelector('#admin-mobile-tabs a.active');
      if (activeBottomTab) {
        activeBottomTab.addEventListener('click', (e) => {
          e.preventDefault();
          dialog.showModal();
        });
      }
    });
  }
  window.addEventListener('load', wire);
})();
