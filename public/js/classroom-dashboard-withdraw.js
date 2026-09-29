// A real request: "all classes should have a delete button... popup that
// says are you sure you want to withdraw from this class? This action
// can't be reversed and a wait listed student may take your spot.
// Buttons cancel or confirm... click confirm and the class is removed
// from the screen and the student is removed from that class roster."
// Same fetch()-based, no-reload pattern public/js/edit-families.js
// already uses with window.confirmAction - routes/parent-portal.js's
// existing /parent/classes/:id/unregister route already responds with
// JSON for a fetch caller (isFetch()), so no new route was needed here.
(function () {
  if (!window.confirmAction) return;
  const statusEl = document.getElementById('classroom-dashboard-status');

  function showError(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = false;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-withdraw-class-btn]');
    if (!btn) return;
    const card = btn.closest('.class-dash-card');

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
        fetch(btn.dataset.withdrawClassUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Requested-With': 'fetch',
            'X-CSRF-Token': window.CSRF_TOKEN || '',
          },
          body: new URLSearchParams({ studentId: btn.dataset.withdrawStudentId || '' }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Could not withdraw from this class.');
            }
            if (statusEl) statusEl.hidden = true;
            if (card) card.remove();
          })
          .catch((err) => {
            btn.disabled = false;
            showError(err.message);
          });
      });
  });
})();
