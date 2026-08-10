// Powers the "View" button on each Class Schedule card: fetches that
// class's info + roster as an HTML fragment and shows it in a shared
// dialog, via the shared public/js/fragment-dialog.js helper, so viewing
// (and, once unlocked, editing) a class never navigates away from the
// grid. Saving/deleting/roster changes are still real form submissions
// (this app has no client framework), so those do leave the popup - they
// land back on this same grid page.
(function () {
  const dialog = document.getElementById('class-view-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  let currentClassId = null;

  function loadClass(id) {
    currentClassId = id;
    window.loadFragmentIntoDialog(dialog, `/admin/class-schedule/classes/${id}/view-fragment`).catch(() => {
      window.location.href = `/admin/class-schedule/classes/${id}/manage`;
    });
  }

  document.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-view-class]');
    if (viewBtn) {
      loadClass(viewBtn.getAttribute('data-view-class'));
      return;
    }

    if (!dialog.open) return;

    if (e.target.closest('[data-edit-class-btn]')) {
      const form = dialog.querySelector('[data-view-form]');
      if (!form) return;
      form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = false; });
      dialog.querySelector('.class-view-footer-view').hidden = true;
      dialog.querySelector('.class-view-footer-edit').hidden = false;
      return;
    }

    if (e.target.closest('[data-cancel-edit-btn]')) {
      if (currentClassId) loadClass(currentClassId);
    }
  });
})();
