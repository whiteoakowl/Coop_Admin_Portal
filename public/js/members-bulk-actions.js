// Members page bulk Delete/Archive/Email/Text: the per-row checkbox
// column and the "Select All" checkbox (both now permanently visible -
// no more "Edit Member List" toggle to reveal them) are handled by
// public/js/archive-select-toggle.js's own generic data-select-all-for
// wiring, reused as-is. This file covers what that one doesn't: a real
// request - "Add a bulk action button to this page. When you select
// members and then click bulk action it will have a drop down menu
// asking if you want to delete the members, email them, text them" -
// picking an option from the page's own <select data-bulk-action-select
// form="..."> routes the shared hidden form (views/main-admin-
// members.ejs/admin-members.ejs's own #members-select-form/#members-
// bulk-form) to whichever endpoint that option names, then submits it
// immediately - no separate "Save" click needed. Archive/Delete still
// go through the sitewide confirm-dialog.js (their <option> carries
// data-bulk-confirm, so the form's own data-confirm gates the submit);
// Email/Text have none, so picking either jumps straight to the compose
// screen (routes/main-admin-announcements.js's/admin-announcements.js's
// own /email/compose, /text/compose - both now accept this page's own
// memberIds[] the same way the Email/Text tab's own recipientIds[]
// already worked, see utils/emailComposer.js's own resolveRecipients()).
//
// Each selected <option> carries its target in data-bulk-action rather
// than the native HTML `formaction` a plain <button type="submit"
// formaction="..."> would use, because confirm-dialog.js's "Yes" button
// re-submits the pending form via `pendingForm.requestSubmit()` with NO
// submitter argument - the browser only honors a clicked button's
// formaction when THAT button is the one actually driving the submit, so
// a submitter-less requestSubmit() silently falls back to the form's own
// plain `action` instead. Setting form.action here directly, before that
// whole submit/confirm/re-submit sequence even starts, sidesteps that
// entirely - by the time requestSubmit() re-fires (on first attempt, or
// after a confirm), the form's own action already IS the right endpoint.
//
// confirm-dialog.js also reads its confirm text from the FORM's own
// data-confirm at submit time, not the option's - same reasoning, this
// sets that form's data-confirm (and -yes-label/-safe) to match whichever
// option was actually picked, clearing it entirely for an option (Email,
// Text) that carries no data-bulk-confirm of its own, so a stale "Delete
// the selected members?" message from a PREVIOUS pick can never leak
// into an Email/Text submit that should go straight through unconfirmed.
(function () {
  document.addEventListener('change', (e) => {
    const select = e.target.closest('[data-bulk-action-select]');
    if (!select) return;
    const option = select.selectedOptions[0];
    const formId = select.getAttribute('form');
    const form = formId && document.getElementById(formId);
    if (!form || !option || !option.dataset.bulkAction) return;

    form.action = option.dataset.bulkAction;
    if (option.dataset.bulkConfirm) form.dataset.confirm = option.dataset.bulkConfirm;
    else delete form.dataset.confirm;
    form.dataset.confirmYesLabel = option.dataset.bulkConfirmYesLabel || 'Yes';
    if (option.dataset.bulkConfirmSafe) form.dataset.confirmSafe = '1';
    else delete form.dataset.confirmSafe;

    // Reset the dropdown back to its placeholder right away - purely
    // cosmetic (the select itself carries no `name`, so its own value is
    // never actually submitted), but leaves it ready to pick the SAME
    // option again later without that looking like a no-op change.
    select.value = '';
    form.requestSubmit();
  });
})();
