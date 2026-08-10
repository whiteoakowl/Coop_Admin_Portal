// Powers clicking a date on the Floater Archive log: fetches that date's
// read-only assignment cards as an HTML fragment and shows it in a shared
// dialog, via the shared public/js/fragment-dialog.js helper. No client
// framework here, so the fetched fragment carries its own Print/Export
// links rather than this script wiring anything beyond fetch-and-show.
(function () {
  const dialog = document.getElementById('volunteer-archive-view-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  const day = document.querySelector('main[data-day]')?.dataset.day;
  if (!day) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view-archive-date]');
    if (!btn) return;
    const date = btn.getAttribute('data-view-archive-date');
    window.loadFragmentIntoDialog(dialog, `/admin/volunteers/${day}/archive/${date}/view-fragment`).catch(() => {});
  });
})();
