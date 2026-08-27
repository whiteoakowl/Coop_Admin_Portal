// Members page bulk Delete/Archive/Restore: the "Edit" toggle, Select All,
// and off-page-checkbox mechanics are all handled by
// public/js/archive-select-toggle.js (reused as-is - it's already generic
// over data-archive-toggle/-controls/-select-all-for/form="<id>", not
// actually specific to "archive"). This file only covers what that one
// doesn't: routing one shared checkbox selection to whichever endpoint
// the admin actually picked - either Co-op Admin's own toolbar buttons
// (Delete/Archive/Restore Selected, all submitting the SAME
// #members-bulk-form) or Main Admin's own single "Actions" dropdown
// (views/main-admin-members.ejs's <select data-bulk-action-select> -
// "a dropdown also appears and says actions, delete or archive are the
// options", a real request).
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

  // A real request (Main Admin Members' Edit mode): "a dropdown also
  // appears and says actions, delete or archive are the options" - the
  // same data-bulk-action/-confirm/-confirm-yes-label/-confirm-safe
  // wiring above, just read off the SELECTED <option> of a
  // <select data-bulk-action-select form="..."> instead of a clicked
  // button, since there's no single element to read data- attributes
  // from otherwise. Submits immediately on change (there's no separate
  // "go" button - picking an action from a placeholder-first dropdown IS
  // the action), then resets back to the placeholder so the dropdown
  // never keeps showing whichever action was last picked.
  document.addEventListener('change', (e) => {
    const select = e.target.closest('[data-bulk-action-select]');
    if (!select) return;
    const option = select.selectedOptions[0];
    if (!option || !option.dataset.bulkAction) return;
    const formId = select.getAttribute('form');
    const form = formId && document.getElementById(formId);
    if (!form) return;
    form.action = option.dataset.bulkAction;
    form.dataset.confirm = option.dataset.bulkConfirm;
    form.dataset.confirmYesLabel = option.dataset.bulkConfirmYesLabel || 'Yes';
    if (option.dataset.bulkConfirmSafe) form.dataset.confirmSafe = '1';
    else delete form.dataset.confirmSafe;
    form.requestSubmit();
    select.value = '';
  });
})();
