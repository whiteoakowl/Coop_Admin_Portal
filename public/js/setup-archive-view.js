// Powers clicking a date on the Setup/Cleanup Archive log: fetches that
// date's read-only assignment cards as an HTML fragment and shows it in a
// shared dialog, via the shared public/js/fragment-dialog.js helper.
// Mirrors public/js/volunteer-archive-view.js exactly, one page over.
(function () {
  const dialog = document.getElementById('setup-archive-view-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  const day = document.querySelector('main[data-day]')?.dataset.day;
  if (!day) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view-setup-archive-date]');
    if (!btn) return;
    const date = btn.getAttribute('data-view-setup-archive-date');
    window.loadFragmentIntoDialog(dialog, `/admin/setup/${day}/archive/${date}/view-fragment`).catch(() => {});
  });
})();
