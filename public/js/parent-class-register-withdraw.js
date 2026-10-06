// Parent Portal's class registration popup (views/parent-class-fragment.
// ejs) - a real request: "when clicking withdraw there is a pop up. It
// should say the same thing that we added when withdrawing from a class
// on the classroom dashboard page. Page should not refresh when withdraw
// happens. Stay on the class and change to the members name and register
// button." Same message, same window.confirmAction + fetch() pattern as
// public/js/classroom-dashboard-withdraw.js (routes/parent-portal.js's
// /parent/classes/:id/unregister route already returns JSON for a fetch
// caller - no new route needed) - this one swaps the row's own already-
// rendered-but-hidden [data-not-registered-state] control into view
// instead of removing a whole card, since the class itself stays open.
(function () {
  if (!window.confirmAction) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-withdraw-btn]');
    if (!btn) return;
    const row = btn.closest('[data-child-row]');
    if (!row) return;

    window
      .confirmAction({
        message: "Are you sure you want to withdraw from this class? This action can't be reversed and a waitlisted student may take your spot.",
        icon: 'icon-trash',
        safe: false,
        yesLabel: 'Confirm',
        cancelLabel: 'Cancel',
      })
      .then((confirmed) => {
        if (!confirmed) return;
        btn.disabled = true;
        fetch(`/parent/classes/${row.dataset.classId}/unregister`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Requested-With': 'fetch',
            'X-CSRF-Token': window.CSRF_TOKEN || '',
          },
          body: new URLSearchParams({ studentId: row.dataset.studentId || '', day: row.dataset.day || '' }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Could not withdraw from this class.');
            }
            row.querySelectorAll('[data-registered-state]').forEach((el) => el.remove());
            const fallback = row.querySelector('[data-not-registered-state]');
            if (fallback) {
              // Removing the attribute (not just .hidden = false) is what
              // actually reveals it - see styles.css's own comment on the
              // [data-not-registered-state] selector for why the plain
              // hidden attribute alone doesn't work for the <form> case.
              fallback.removeAttribute('data-not-registered-state');
              fallback.hidden = false;
            }
          })
          .catch((err) => {
            btn.disabled = false;
            window.alert(err.message || 'Could not withdraw from this class.');
          });
      });
  });
})();
