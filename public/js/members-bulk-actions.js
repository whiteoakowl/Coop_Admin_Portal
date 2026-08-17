// Members page bulk Delete/Archive/Restore: the "Edit" toggle, Select All,
// and off-page-checkbox mechanics are all handled by
// public/js/archive-select-toggle.js (reused as-is - it's already generic
// over data-archive-toggle/-controls/-select-all-for/form="<id>", not
// actually specific to "archive"). This file only covers what that one
// doesn't: the toolbar's three buttons (Delete/Archive/Restore Selected)
// all submit the SAME #members-bulk-form, so one shared checkbox
// selection can go to any of three different endpoints.
//
// Each button carries its target in data-bulk-action rather than the
// native HTML `formaction` attribute a plain <button type="submit"
// formaction="..."> would use, because confirm-dialog.js's "Yes" button
// re-submits the pending form via `pendingForm.requestSubmit()` with NO
// submitter argument - the browser only honors a clicked button's
// formaction when THAT button is the one actually driving the submit, so
// a submitter-less requestSubmit() silently falls back to the form's own
// plain `action` instead, sending every bulk action to whichever URL the
// <form> tag itself happens to have. Setting form.action here directly,
// in a click handler that runs before that whole submit/confirm/re-submit
// sequence even starts, sidesteps that entirely - by the time
// requestSubmit() re-fires, the form's own action already IS the right
// endpoint.
//
// confirm-dialog.js also reads its confirm text from the FORM's own
// data-confirm at submit time, not the button's - same reasoning, this
// sets that form's data-confirm (and -yes-label/-safe) to match whichever
// button was actually clicked.
(function () {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk-action]');
    if (!btn) return;
    const formId = btn.getAttribute('form');
    const form = formId && document.getElementById(formId);
    if (!form) return;
    form.action = btn.dataset.bulkAction;
    form.dataset.confirm = btn.dataset.bulkConfirm;
    form.dataset.confirmYesLabel = btn.dataset.bulkConfirmYesLabel || 'Yes, Delete';
    if (btn.dataset.bulkConfirmSafe) form.dataset.confirmSafe = '1';
    else delete form.dataset.confirmSafe;
  });
})();
