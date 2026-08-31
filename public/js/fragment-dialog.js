// Shared "fetch an HTML fragment, drop it into a <dialog>, open it"
// pattern - every one of this app's fetch-into-dialog popups (Class
// Schedule view, Floater Archive view, Roster Archive view, and the
// Members page's per-row Cards/Schedule dialogs) wants the exact same
// four steps (fetch -> check ok -> swap innerHTML -> show), so this
// exists purely so they can't drift from each other one caller at a
// time, the way they had before this file existed.
//
// Returns the fetch promise chain (resolving after the dialog is shown,
// rejecting with the response status on a non-OK response) so a caller
// can still attach its own .then()/.catch() - e.g. running
// window.renderNameTagBarcodes() against the now-populated dialog, or
// falling back to a full-page navigation if the fetch fails.
(function () {
  function loadFragmentIntoDialog(dialog, url) {
    return fetch(url, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((html) => {
        dialog.innerHTML = html;
        if (!dialog.open) dialog.showModal();
        // A real bug report: a fragment's own .roster-btn-row toolbar
        // (e.g. the Class Schedule view popup's Add Member/Import/Export/
        // Print/Allergies/Class Check-In row) rendered as one full-width
        // button per row on mobile instead of the same balanced ≤4-per-row
        // grid every other toolbar gets - public/js/roster-btn-row-grid.js
        // only ever lays those out on the page's own load/resize events,
        // which have already long since fired by the time a fragment gets
        // fetched into a dialog well after page load. Dispatching a
        // synthetic resize reuses that exact same listener instead of
        // needing a second, parallel layout mechanism just for dialogs.
        window.dispatchEvent(new Event('resize'));
      });
  }

  window.loadFragmentIntoDialog = loadFragmentIntoDialog;
})();
