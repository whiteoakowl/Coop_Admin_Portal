// Setup/Cleanup Teams card (views/admin-setup.ejs): a real request - "if
// you click the trash button the member name should automatically go
// away without having to save the team or refreshing the page." Unlike
// Floater Teams' own trash icon (still a stage-until-Save checkbox, see
// public/js/team-member-remove-toggle.js), this one removes the member
// right away: confirm via the shared styled dialog (public/js/confirm-
// dialog.js's window.confirmAction, same promise-based pattern public/js/
// edit-families.js uses for its own instant Delete), then fetch() the
// removal and drop that one row out of the still-open card on success.
(function () {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-member-instant-remove-btn]');
    if (!btn) return;
    const row = btn.closest('[data-member-remove-row]');
    const url = btn.getAttribute('data-member-remove-url');
    if (!row || !url) return;
    // aria-label is already "Remove <name>" (see admin-setup.ejs) - reuse
    // it directly rather than threading the plain name through as its own
    // data attribute just for this.
    const label = btn.getAttribute('aria-label') || 'Remove this member';

    const confirmed = await window.confirmAction({
      message: `${label} from this team?`,
      yesLabel: 'Yes, Remove',
    });
    if (!confirmed) return;

    btn.disabled = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      });
      if (!res.ok) throw new Error('Could not remove member.');
      row.remove();
    } catch (err) {
      window.alert('Could not remove this member - please try again.');
      btn.disabled = false;
    }
  });
})();
