// Real request: "after any bulk printing the page should refresh on its
// own." Every bulk print form on this page opens its print job in a new
// tab and otherwise leaves the origin page exactly as the admin left it -
// stale checkbox selections, filters, and any old notice/error banner all
// just sit there until a manual reload. Any form meant to get this
// behavior is marked with data-bulk-print-refresh in its own markup
// (admin-design.ejs, partials/misc-badge-print-panel.ejs, admin-name-
// tag.ejs) - this listens for ANY such form submitting (the 'submit'
// event bubbles, so one document-level listener covers all of them with
// no per-form JS wiring needed) and reloads the origin page shortly
// after, so it comes back clean while the print tab handles the actual
// job independently.
//
// Deliberately NOT keyed off form.target === '_blank': every one of
// these forms starts out that way in markup, but print-blank-target.js
// (partials/admin-nav.ejs, loaded before this script and attached to the
// same document-level 'submit' event first) rewrites a form's live
// .target to a synthetic window name as part of its own submit handling,
// before this listener ever gets to see it - checking the live property
// here would silently never match anything past that rewrite.
//
// Skips a form whose submit was already intercepted and prevented by
// something else (design-print-hub.js's printInChunks, for a selection
// large enough to need batching) - that path reloads on its own once the
// whole chunked job has actually finished being assembled, not on a fixed
// delay that could fire before the print tab is even open yet.
(function () {
  document.addEventListener('submit', function (e) {
    const form = e.target;
    // A valueless data-bulk-print-refresh attribute (the shape every form
    // carries it in) reads as an empty string here, not undefined - `in`
    // checks presence, not truthiness, so it isn't mistaken for absent.
    if (!(form instanceof HTMLFormElement) || !('bulkPrintRefresh' in form.dataset) || e.defaultPrevented) return;
    setTimeout(() => window.location.reload(), 300);
  });
})();
