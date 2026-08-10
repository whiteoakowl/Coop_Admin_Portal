// Powers the "Allergies/Medical" button on roster and class view pages:
// fetches the current Allergies/Medical log as an HTML fragment and shows
// it in a shared dialog, so it's reachable from wherever staff need it
// without leaving the page. Uses the shared public/js/fragment-dialog.js
// helper, same as class-schedule-view.js.
(function () {
  const dialog = document.getElementById('allergy-log-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  // This script may be included on a page (e.g. the Class Schedule grid)
  // whose "Allergies/Medical" button lives inside content that itself
  // gets re-fetched/re-injected (the class View popup) - guard against
  // attaching this document-level listener more than once.
  if (window.__allergyLogPopupInstalled) return;
  window.__allergyLogPopupInstalled = true;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-open-allergy-log]')) return;
    window.loadFragmentIntoDialog(dialog, '/admin/logs/allergies/fragment').catch(() => {
      window.location.href = '/admin/logs?tab=allergies';
    });
  });
})();
