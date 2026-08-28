// Powers the click-a-class-card popup on Parent Portal's Classes grid:
// fetches that class's info + this family's register/cancel controls as
// an HTML fragment and shows it in a shared dialog, via the shared
// public/js/fragment-dialog.js helper - same pattern Co-op Admin's own
// Class Schedule grid uses for its View popup (public/js/class-schedule-
// view.js), just with no edit-unlock step since a parent never edits the
// class itself here. Register/Cancel inside the popup are plain form
// POSTs (no fetch plumbing) - each redirects back to this same day's
// grid with a notice, which is a simple, robust choice worth keeping
// over reimplementing class-schedule-view.js's own in-dialog-refresh
// trick for an action a parent takes rarely, not repeatedly like an
// admin building out a roster.
(function () {
  const dialog = document.getElementById('parent-class-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-view-class]');
    if (!card) return;
    const id = card.getAttribute('data-view-class');
    const day = card.getAttribute('data-view-class-day') || '';
    const url = `/parent/classes/${id}/fragment${day ? `?day=${encodeURIComponent(day)}` : ''}`;
    window.loadFragmentIntoDialog(dialog, url).catch(() => {
      window.location.href = `/parent/classes${day ? `?day=${encodeURIComponent(day)}` : ''}`;
    });
  });
})();
