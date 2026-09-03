// A real request: "any pages, do no refresh the page when clicking button
// or icons. it should do the task and stay on the screen so you don't
// have to search for families and members again." The Members list's own
// per-row Delete (both portals), Archive, and Reactivate/Unarchive
// (Main Admin) buttons were plain <form> submits that redirected back to
// a fixed, unfiltered /admin/members or /main-admin/members URL on every
// click - losing whatever Filter/Family/search/page an admin had picked
// before taking the action, exactly the "search again" complaint. Same
// fetch()-based approach public/js/member-name-tag-request.js already
// uses for this same list's own send-icon - routes/admin-members.js and
// routes/main-admin-members.js's own delete/archive/unarchive routes
// respond with JSON for a fetch caller (isFetch()) instead of redirecting,
// so nothing here ever navigates the page at all.
//
// On success the whole row is removed from the DOM in place - Archive and
// Delete both mean "this member no longer belongs on the view you're
// looking at" (the live tab for Archive, either tab for Delete), and
// Reactivate means the same for the Archive tab.
(function () {
  if (!window.confirmAction) return;

  // The family-collapse toggle (public/js/members-family-collapse.js)
  // lives on the family's own head row - if a row that's about to be
  // removed was that head, its sibling rows (already hidden via
  // .family-row-collapsed, with no toggle of their own) would be
  // orphaned with nothing left to un-collapse them. Simplest safe fix:
  // un-collapse the whole family group before removing any of its rows,
  // rather than trying to re-target the toggle at a new head row -
  // worst case the family just shows fully expanded until the next
  // reload, never permanently hidden.
  function uncollapseFamily(row) {
    const key = row.dataset.familyKey;
    if (!key || !window.CSS || !CSS.escape) return;
    document.querySelectorAll(`tr[data-family-key="${CSS.escape(key)}"]`).forEach((r) => r.classList.remove('family-row-collapsed'));
  }

  function removeRow(btn) {
    const row = btn.closest('tr');
    if (!row) return;
    uncollapseFamily(row);
    row.remove();
  }

  function postFetch(url) {
    return fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
    });
  }

  document.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-member-delete-url]');
    if (deleteBtn) {
      const url = deleteBtn.dataset.memberDeleteUrl;
      const name = deleteBtn.dataset.memberDeleteName || 'this member';
      // Each portal's original <form data-confirm> carried slightly
      // different wording (Co-op Admin's own list also touches volunteer
      // lists; Main Admin's doesn't) - a data attribute keeps that exact,
      // already-shipped wording per portal instead of hardcoding one here.
      const message = deleteBtn.dataset.memberDeleteMessage || `Permanently delete ${name}? This cannot be undone.`;
      window
        .confirmAction({
          message,
          icon: 'icon-trash',
          safe: false,
          yesLabel: 'Yes, Delete',
          cancelLabel: 'Cancel',
        })
        .then((confirmed) => {
          if (!confirmed) return;
          deleteBtn.disabled = true;
          postFetch(url)
            .then((res) => {
              if (!res.ok) throw new Error('Could not delete this member.');
              removeRow(deleteBtn);
            })
            .catch(() => {
              deleteBtn.disabled = false;
            });
        });
      return;
    }

    const archiveBtn = e.target.closest('[data-member-archive-url]');
    if (archiveBtn) {
      archiveBtn.disabled = true;
      postFetch(archiveBtn.dataset.memberArchiveUrl)
        .then((res) => {
          if (!res.ok) throw new Error('Could not archive this member.');
          removeRow(archiveBtn);
        })
        .catch(() => {
          archiveBtn.disabled = false;
        });
      return;
    }

    const unarchiveBtn = e.target.closest('[data-member-unarchive-url]');
    if (unarchiveBtn) {
      unarchiveBtn.disabled = true;
      postFetch(unarchiveBtn.dataset.memberUnarchiveUrl)
        .then((res) => {
          if (!res.ok) throw new Error('Could not reactivate this member.');
          removeRow(unarchiveBtn);
        })
        .catch(() => {
          unarchiveBtn.disabled = false;
        });
    }
  });
})();
