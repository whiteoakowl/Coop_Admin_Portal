// Archive tab's log-list row -> read-only view popup, mirroring
// public/js/volunteer-archive-view.js's fetch-a-fragment-into-a-dialog
// pattern. No day-scoping needed here (unlike Floater's per-day archive
// routes) - a roster archive id is already globally unique across both
// days, and each row's data-view-archive-id carries it directly.
(function () {
  const dialog = document.getElementById('roster-archive-view-dialog');
  if (!dialog) return;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view-archive-id]');
    if (!btn) return;
    const id = btn.getAttribute('data-view-archive-id');
    fetch(`/admin/rosters/archive/${id}/view-fragment`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((html) => {
        dialog.innerHTML = html;
        if (!dialog.open) dialog.showModal();
      })
      .catch(() => {});
  });
})();
