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
// builder tabs, one class's own detail tabs, and Settings - because
// they're reached by clicking into a specific record, not from the nav,
// so there's no top-level "section" for them to attach to. Those keep a
// plain, always-visible <div class="view-tabs"> instead (see
// admin-member-profile.ejs and friends), with nothing here to wire up.
(function () {
  // This script loads from the shared nav partials, included near the
  // TOP of <body> - well before the rest of <main> has even been parsed
  // yet. A plain immediate run would find nothing to wire up (same
  // reasoning as public/js/roster-btn-row-grid.js's own 'load' listener).
  function wire() {
    const pairs = [];
    document.querySelectorAll('[data-subpages-dialog]').forEach((trigger) => {
      const dialog = document.getElementById(trigger.dataset.subpagesDialog);
      if (!dialog) return;
      pairs.push({ trigger, dialog });
      // A real request: "clicking on the orange menu tab options does NOT
      // open the page, you still have to click a subpage" - this trigger
      // is a <button>, never an <a>, so it never navigates on its own;
      // toggling open/closed here just means tapping an already-open
      // section's own icon again closes its popup instead of doing
      // nothing (or re-opening an already-open dialog, a no-op that read
      // as "stuck open" otherwise).
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        // .show(), not .showModal() - see styles.css's own comment on
        // .page-tabs-dialog[open] for why: a modal <dialog> makes the
        // entire rest of the document inert while open, including this
        // very trigger, which would make "tap the bar again to close it"
        // (right below) impossible to actually click.
        if (dialog.open) dialog.close();
        else dialog.show();
      });
    });

    // A real request: "close shouldn't be on the list. Simply clicking a
    // subpage or outside the list or clicking on the orange menu bar tabs
    // will close the subpage menu" - a plain document-level "was this
    // click outside the open dialog" check. A non-modal .show() dialog
    // has no ::backdrop and doesn't make the rest of the page inert, so a
    // click on anything outside this popup - the bar, a subpage link, the
    // page behind it - reaches its real target normally; this just also
    // closes whichever popup was left open when that happens.
    document.addEventListener('click', (e) => {
      pairs.forEach(({ trigger, dialog }) => {
        if (!dialog.open) return;
        if (dialog.contains(e.target) || trigger.contains(e.target)) return;
        dialog.close();
      });
    });
  }
  window.addEventListener('load', wire);
})();
