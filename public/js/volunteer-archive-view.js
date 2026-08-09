// Powers clicking a date on the Floater Archive log: fetches that date's
// read-only assignment cards as an HTML fragment and shows it in a shared
// dialog (mirrors public/js/member-view.js). No client framework here, so
// the fetched fragment carries its own Print/Export links rather than
// this script wiring anything beyond fetch-and-show.
(function () {
  const dialog = document.getElementById('volunteer-archive-view-dialog');
  if (!dialog) return;

  const day = document.querySelector('main[data-day]')?.dataset.day;
  if (!day) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view-archive-date]');
    if (!btn) return;
    const date = btn.getAttribute('data-view-archive-date');
    fetch(`/admin/volunteers/${day}/archive/${date}/view-fragment`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((html) => {
        dialog.innerHTML = html;
        if (!dialog.open) dialog.showModal();
      })
      .catch(() => {});
  });
})();
