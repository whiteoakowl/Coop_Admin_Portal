// A real request: "mobile view instead of tabs on all the pages. when
// you click the tab below a menu will pop up showing the different page
// choices," later sharpened to: "the tab should not work on mobile until
// you click the subpage" - the popup has to be reachable from ANY page in
// a section, not just from the one page whose own markup happened to
// carry the dialog. views/partials/admin-nav.ejs and portal-nav.ejs now
// render a <dialog class="page-tabs-dialog"> for every nav item that has
// subpages directly in the nav shell itself (present on every page,
// unlike the old per-page dialogs), paired with a
// <button data-subpages-dialog="that dialog's id"> in the bottom orange
// bar in place of a plain <a> - tapping it always opens the popup, first,
// on every page in that section; only clicking a link inside the popup
// itself ever navigates.
//
// A handful of pages have no such nav-shell entry at all - a single
// member's own Profile/Class Schedule/Attendance tabs, one event's own
// builder tabs, one class's own detail tabs - because they're reached by
// clicking into a specific record, not from the nav, so there's no
// top-level "section" for them to attach to. Those keep their original
// per-page .page-tabs-trigger/.page-tabs-dialog pair (see styles.css's
// own .page-tabs-trigger-standalone, which keeps that trigger visible
// everywhere instead of the base rule's permanent display: none).
(function () {
  // This script loads from the shared nav partials, included near the
  // TOP of <body> - well before the rest of <main> (and, on standalone-
  // trigger pages, that page's own trigger/dialog markup) has even been
  // parsed yet. A plain immediate run would find nothing to wire up (same
  // reasoning as public/js/roster-btn-row-grid.js's own 'load' listener).
  function wire() {
    document.querySelectorAll('[data-subpages-dialog]').forEach((trigger) => {
      const dialog = document.getElementById(trigger.dataset.subpagesDialog);
      if (!dialog) return;
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        dialog.showModal();
      });
    });

    document.querySelectorAll('.page-tabs-trigger-standalone').forEach((trigger) => {
      const dialog = trigger.nextElementSibling;
      if (!dialog || !dialog.classList.contains('page-tabs-dialog')) return;
      const activeTab = dialog.querySelector('.view-tab.active');
      const label = trigger.querySelector('.page-tabs-trigger-label');
      if (activeTab && label) label.textContent = activeTab.textContent.trim();
      trigger.addEventListener('click', () => dialog.showModal());
    });
  }
  window.addEventListener('load', wire);
})();
