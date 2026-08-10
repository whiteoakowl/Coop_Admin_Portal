// Archive tab's log-list row -> read-only view popup, via the shared
// public/js/fragment-dialog.js helper. No day-scoping needed here
// (unlike Floater's per-day archive routes) - a roster archive id is
// already globally unique across both days, and each row's
// data-view-archive-id carries it directly.
(function () {
  const dialog = document.getElementById('roster-archive-view-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view-archive-id]');
    if (!btn) return;
    const id = btn.getAttribute('data-view-archive-id');
    window.loadFragmentIntoDialog(dialog, `/admin/rosters/archive/${id}/view-fragment`).catch(() => {});
  });
})();
