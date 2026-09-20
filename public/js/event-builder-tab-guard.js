// A real request: "editing event should have little tabs at the top.
// details, finance, settings, attendance. warning pop up when clicking to
// each page/tab that you must save your changes on that page before going
// to the next. cancel and continue buttons." Distinct from the site-wide
// public/js/unsaved-changes.js (a native beforeunload prompt, and only for
// typed text) - this is a same-page Cancel/Continue dialog, and tracks any
// edit (checkboxes/radios/selects included, not just typing) since none of
// this page's own tab forms auto-submit on change the way some other pages'
// controls do.
(function () {
  const dialog = document.getElementById('tab-unsaved-dialog');
  if (!dialog) return;

  const guardedForms = Array.from(document.querySelectorAll('#main-content form')).filter((form) => !form.closest('dialog'));
  let dirty = false;
  let pendingHref = null;

  guardedForms.forEach((form) => {
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('change', () => {
      dirty = true;
    });
    form.addEventListener('submit', () => {
      dirty = false;
    });
  });

  document.querySelectorAll('[data-builder-nav-link]').forEach((link) => {
    link.addEventListener('click', (e) => {
      if (!dirty) return;
      e.preventDefault();
      pendingHref = link.getAttribute('href');
      dialog.showModal();
    });
  });

  const continueBtn = dialog.querySelector('[data-tab-guard-continue]');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      dirty = false;
      dialog.close();
      if (pendingHref) window.location.href = pendingHref;
    });
  }
})();
