// Sitewide fix for a mobile bug report: bulk print buttons (Design/Print
// tab, Name Tags print tab, etc.) are plain <form method="POST"
// target="_blank"> submissions - fine on desktop, but this app is also an
// installed PWA (manifest.json's "display": "standalone"), and standalone
// mode on mobile browsers routinely can't honor a bare target="_blank" on
// a POST: the new context it opens re-requests the URL as a GET instead of
// carrying the original POST body along, and every one of these print
// routes only ever registers a POST handler - so the "new tab" that opens
// is just a 404 for a route that's never had a GET.
//
// Event delegation (matches confirm-dialog.js's pattern) so this covers
// every current and future form[target="_blank"] without each one needing
// its own wiring, including ones injected later via fetch. window.open('',
// '_blank') is called synchronously inside the submit handler - still a
// direct user-gesture response, so popup blockers allow it - then the form
// is retargeted at that already-open window by name and left to submit
// natively (a real POST, not reimplemented over fetch). Named-window
// targeting is far more consistently honored across mobile/PWA contexts
// than the bare target="_blank" keyword. If window.open is blocked or
// unsupported (returns null/undefined), the target attribute is left
// alone and the form falls back to submitting in the current tab - no new
// tab, but never a 404.
(function () {
  let nextWindowName = 0;

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.target !== '_blank') return;

    const w = window.open('', `print-preview-${Date.now()}-${nextWindowName++}`);
    if (w) form.target = w.name;
  });
})();
