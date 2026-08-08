// Powers the "Allergies/Medical" button on roster and class view pages:
// fetches the current Allergies/Medical log as an HTML fragment and shows
// it in a shared dialog, so it's reachable from wherever staff need it
// without leaving the page. Same fetch-and-inject pattern as
// class-schedule-view.js.
(function () {
  const dialog = document.getElementById('allergy-log-dialog');
  if (!dialog) return;

  // This script may be included on a page (e.g. the Class Schedule grid)
  // whose "Allergies/Medical" button lives inside content that itself
  // gets re-fetched/re-injected (the class View popup) - guard against
  // attaching this document-level listener more than once.
  if (window.__allergyLogPopupInstalled) return;
  window.__allergyLogPopupInstalled = true;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-open-allergy-log]')) return;
    fetch('/admin/logs/allergies/fragment', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((html) => {
        dialog.innerHTML = html;
        if (!dialog.open) dialog.showModal();
      })
      .catch(() => {
        window.location.href = '/admin/logs?tab=allergies';
      });
  });
})();
