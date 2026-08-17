// Members page's Edit Families dialog: Delete Family is deliberately NOT
// a submitting <form> (see admin-members.ejs's own comment on the button)
// - a real page navigation on every single delete would close this whole
// dialog, forcing an admin clearing out several old families to reopen it
// from scratch each time. Instead: confirm via the shared styled dialog
// (public/js/confirm-dialog.js's window.confirmAction, a promise-based
// sibling to its form-submit-driven path), then fetch() the delete and
// just remove that one <li> from the still-open list on success.
(function () {
  const list = document.getElementById('edit-families-list');
  if (!list) return;
  const emptyMessage = document.getElementById('edit-families-empty');

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-family]');
    if (!btn) return;
    const id = btn.getAttribute('data-delete-family');
    const name = btn.dataset.familyName || '';
    const memberCount = btn.dataset.memberCount || '0';

    const confirmed = await window.confirmAction({
      message: `Delete the "${name}" family? ${memberCount} member(s) will no longer be grouped under it, but no member is deleted.`,
      yesLabel: 'Yes, Delete',
    });
    if (!confirmed) return;

    btn.disabled = true;
    try {
      const res = await fetch(`/admin/members/families/${id}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      });
      if (!res.ok) throw new Error('Could not delete family.');

      const row = list.querySelector(`li[data-family-id="${id}"]`);
      if (row) row.remove();
      if (!list.querySelector('li') && emptyMessage) {
        list.hidden = true;
        emptyMessage.hidden = false;
      }

      // The "Filter by type or family" dropdown's own <option> for this
      // family (admin-members.ejs's #type-select) is built from this same
      // families list - drop it too, so it doesn't keep offering a family
      // that no longer exists for the rest of this page view. The Members
      // table itself isn't touched here (nothing on screen actually
      // belonged to the deleted family's own row - deleting a family only
      // ever ungroups members, see the route's own comment - so there's
      // nothing on that table that needs to change).
      const filterOption = document.querySelector(`#type-select option[value="/admin/members?family=${id}"]`);
      if (filterOption) filterOption.remove();
    } catch (err) {
      btn.disabled = false;
      window.alert(err.message || 'Could not delete family.');
    }
  });
})();
