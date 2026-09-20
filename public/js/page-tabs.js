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
  // A real request: "on mobile add a fit to text drop down menu next to
  // each page title with the subpages as a secondary way of accessing
  // the subpages" - reuses the exact same per-section <dialog> the
  // orange bar's own trigger already opens (below), so this is purely a
  // second entry point onto it, not a separate menu/dialog to keep in
  // sync. Finding "which dialog is this page's own section" duplicates
  // admin-nav-accordion.js's own findActiveLink matching (query params
  // included, not just pathname - see that file's own comment on why)
  // rather than depending on load order between the two scripts.
  function findCurrentSectionDialog() {
    const here = new URL(window.location.href);
    const dialogs = Array.prototype.slice.call(document.querySelectorAll('.page-tabs-dialog[id^="mobile-subpages-"]'));
    function linksOf(dialog) {
      return Array.prototype.slice.call(dialog.querySelectorAll('.view-tab'));
    }
    let best = null;
    let bestCount = -1;
    dialogs.forEach((dialog) => {
      linksOf(dialog).forEach((a) => {
        const url = new URL(a.getAttribute('href'), window.location.origin);
        if (url.pathname !== here.pathname) return;
        const params = Array.prototype.slice.call(url.searchParams.entries());
        const isMatch = params.every(([k, v]) => here.searchParams.get(k) === v);
        if (!isMatch || !params.length) return;
        if (params.length > bestCount) {
          best = dialog;
          bestCount = params.length;
        }
      });
    });
    if (best) return best;
    return (
      dialogs.find((dialog) =>
        linksOf(dialog).some((a) => {
          const url = new URL(a.getAttribute('href'), window.location.origin);
          return url.pathname === here.pathname && !url.search;
        })
      ) || null
    );
  }

  // "fit to text" - a plain inline trigger, sized to its own label, not a
  // full-width block. A real follow-up request: "the dropdown is in a
  // different location on every page - it should always be next to the
  // title, with decent space between, on the same row." Inserting the
  // trigger as the <h1>'s own SIBLING (the original approach) put its
  // position at the mercy of whatever container the heading happened to
  // sit in on that particular page - a .grid-box-header's own
  // justify-content: space-between, for one, spreads 3 flex children
  // (title, trigger, the page's own button row) evenly across the whole
  // row instead of keeping the first two together, landing the trigger
  // nowhere near the title. Appending the trigger INSIDE the <h1> instead
  // - as its last child, right after the title's own text - makes the
  // <h1> the single flex item its own parent's layout has to deal with,
  // however that parent already positions ONE heading element; the
  // trigger's position relative to the title text is then governed only
  // by .page-title-has-menu's own flex/gap rule on this file's own <h1>,
  // identical on every page regardless of what wraps it.
  function insertPageTitleTrigger() {
    const dialog = findCurrentSectionDialog();
    if (!dialog) return;
    const h1 = document.querySelector('#main-content h1, main h1');
    if (!h1) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-title-subpages-trigger';
    btn.dataset.subpagesDialog = dialog.id;
    btn.setAttribute('aria-label', 'Page menu');
    btn.innerHTML = 'Menu <svg class="icon"><use href="#icon-chevron-down"/></svg>';
    h1.appendChild(btn);
    h1.classList.add('page-title-has-menu');
  }

  function wire() {
    insertPageTitleTrigger();
    // Keyed by dialog, not a flat trigger/dialog list - the page-title
    // trigger above and the orange bar's own trigger can now both open
    // the SAME dialog (a real request: "a secondary way of accessing the
    // subpages", not a separate one to keep in sync). The outside-click
    // check below has to recognize a click on EITHER of a dialog's own
    // triggers as "not outside" - keying by one arbitrary trigger per
    // dialog would make clicking trigger B look like an outside click to
    // trigger A's own pair and immediately re-close the dialog B just
    // opened.
    const triggersByDialog = new Map();
    document.querySelectorAll('[data-subpages-dialog]').forEach((trigger) => {
      const dialog = document.getElementById(trigger.dataset.subpagesDialog);
      if (!dialog) return;
      if (!triggersByDialog.has(dialog)) triggersByDialog.set(dialog, []);
      triggersByDialog.get(dialog).push(trigger);
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
      triggersByDialog.forEach((triggers, dialog) => {
        if (!dialog.open) return;
        if (dialog.contains(e.target)) return;
        if (triggers.some((trigger) => trigger.contains(e.target))) return;
        dialog.close();
      });
    });
  }
  window.addEventListener('load', wire);
})();
