// A real request: "when clicking the icon on member list to send to name
// tags request log the page should not refresh everytime." Every icon
// this drives (Co-op Admin's admin-members.ejs, Main Admin's own
// main-admin-members.ejs) used to be a <form data-confirm="..."> - a real
// submit that redirected back to the same Members list, reloading the
// whole page just to add one row to the queue. Reuses window.confirmAction
// (public/js/confirm-dialog.js) instead - the same escape hatch the Edit
// Families dialog's own Delete button already uses for the identical
// reason - so the click stays a fetch() the whole way through. See routes/
// admin-members.js and routes/main-admin-members.js's own isFetch() check
// on this same route for the JSON-vs-redirect branch this relies on.
//
// On success the button swaps itself into the same "already on the log"
// info-only state Co-op Admin's own pendingNameTagMemberIds branch renders
// (admin-members.ejs) - confirm-dialog.js's info-button click handler is
// delegated, so adding those data attributes to an existing button is
// enough to pick it up with no re-binding needed. Main Admin doesn't
// server-track that state across a reload the way Co-op Admin does, but
// showing it for the rest of THIS page view still beats a second click
// silently queuing a second, invisible duplicate with no feedback at all.
(function () {
  if (!window.confirmAction) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-name-tag-request-url]');
    if (!btn) return;
    const url = btn.dataset.nameTagRequestUrl;

    window
      .confirmAction({
        message: 'Add this name tag to the request log?',
        icon: 'icon-send',
        safe: true,
        yesLabel: 'Yes',
        cancelLabel: 'No',
      })
      .then((confirmed) => {
        if (!confirmed) return;
        btn.disabled = true;
        fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'fetch',
            'X-CSRF-Token': window.CSRF_TOKEN || '',
          },
        })
          .then((res) => {
            if (!res.ok) throw new Error('Could not add this name tag to the request log.');
            btn.disabled = false;
            btn.removeAttribute('data-name-tag-request-url');
            btn.dataset.infoMessage = 'This member is already on the name tags request log.';
            btn.dataset.infoIcon = 'icon-send';
          })
          .catch(() => {
            btn.disabled = false;
          });
      });
  });
})();
