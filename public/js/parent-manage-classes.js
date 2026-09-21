// A real request: "Trash button at the end of the row of each class,
// red. When they click trash they are removed from that class roster and
// the class instantly deletes from their schedule without refreshing the
// page." Same fetch()-based, no-reload approach public/js/member-row-
// actions.js already uses for the Members list's own row actions -
// routes/parent-portal.js's unregister route responds with JSON for a
// fetch caller (isFetch()) instead of redirecting.
(function () {
  if (!window.confirmAction) return;

  function removeRow(row) {
    const list = row.parentElement;
    const groupHeader = row.previousElementSibling && row.previousElementSibling.classList.contains('manage-classes-group-header')
      ? row.previousElementSibling
      : null;
    row.remove();
    // If that was the only row under its child-name header, drop the now-
    // empty header too rather than leaving a name with nothing under it.
    if (groupHeader) {
      const next = groupHeader.nextElementSibling;
      if (!next || next.classList.contains('manage-classes-group-header')) groupHeader.remove();
    }
    if (list && !list.querySelector('[data-class-row]')) {
      const empty = document.createElement('p');
      empty.className = 'roster-empty';
      empty.textContent = "No one in your family is registered for a class yet.";
      list.replaceWith(empty);
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel-class-btn]');
    if (!btn) return;
    const row = btn.closest('[data-class-row]');
    window
      .confirmAction({
        message: 'Cancel this class registration? This cannot be undone.',
        icon: 'icon-trash',
        safe: false,
        yesLabel: 'Yes, Cancel',
        cancelLabel: 'Keep Registration',
      })
      .then((confirmed) => {
        if (!confirmed) return;
        btn.disabled = true;
        fetch(btn.dataset.cancelClassUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Requested-With': 'fetch',
            'X-CSRF-Token': window.CSRF_TOKEN || '',
          },
          body: new URLSearchParams({
            studentId: btn.dataset.cancelStudentId || '',
            day: btn.dataset.cancelDay || '',
          }),
        })
          .then((res) => {
            if (!res.ok) throw new Error('Could not cancel this registration.');
            if (row) removeRow(row);
          })
          .catch(() => {
            btn.disabled = false;
          });
      });
  });
})();
