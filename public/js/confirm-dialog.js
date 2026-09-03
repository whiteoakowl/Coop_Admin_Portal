// Sitewide "are you sure?" popup, replacing the browser's native confirm()
// everywhere. Any <form data-confirm="..."> is intercepted on submit
// (event delegation - works for forms injected later via fetch too, e.g.
// class-schedule-view-fragment.ejs) and shown this dialog instead; the
// Yes button re-submits the same form (marking it confirmed first so the
// listener doesn't just intercept it again), Cancel closes without doing
// anything.
//
// Defaults to the original delete framing (trash icon, red "Yes, Delete"
// button) so every existing data-confirm form (removals, deletions) needs
// no changes. A form for a confirm that ISN'T a delete - e.g. the roster
// Archive button, which is a safe, reversible-in-spirit save+reset, not a
// destructive action - can opt into different wording/styling via
// data-confirm-yes-label (button text), data-confirm-icon (icon symbol
// id, e.g. "icon-save"), and data-confirm-safe (any truthy value swaps
// the red danger button for the standard orange .primary-btn). Every
// attribute resets to its default when a different form's confirm opens
// next, so nothing leaks between an Archive click and a Delete click on
// the same page.
//
// window.confirmAction(options) is the same dialog for callers that
// can't use the form-submit path at all - e.g. the Edit Families dialog's
// own Delete button (public/js/edit-families.js), which does its own
// fetch() so the family's row can disappear in place instead of a full
// page navigation closing the dialog out from under the admin mid-cleanup.
// Returns a Promise<boolean> (true = confirmed) instead of re-submitting
// anything itself - the caller decides what "confirmed" actually does.
//
// A third mode, for any <button data-info-message="..."> (e.g. the
// Members list's "already on the name tags request log" icon - see
// views/admin-members.ejs), shows the same dialog with a single OK
// button and no Cancel - purely informational, nothing to submit or
// resolve.
(function () {
  const dialog = document.getElementById('confirm-dialog');
  if (!dialog) return;
  const messageEl = document.getElementById('confirm-dialog-message');
  const iconEl = dialog.querySelector('.confirm-dialog-icon');
  const iconUse = iconEl.querySelector('use');
  const yesBtn = dialog.querySelector('[data-confirm-yes]');
  const cancelBtn = dialog.querySelector('[data-confirm-cancel]');
  let pendingForm = null;
  let pendingResolve = null;

  function open(options) {
    messageEl.textContent = options.message;
    iconUse.setAttribute('href', `#${options.icon || 'icon-trash'}`);
    iconEl.classList.toggle('confirm-icon-safe', !!options.safe);
    yesBtn.textContent = options.yesLabel || 'Yes, Delete';
    yesBtn.classList.toggle('primary-btn', !!options.safe);
    yesBtn.classList.toggle('roster-action-btn-danger', !options.safe);
    cancelBtn.textContent = options.cancelLabel || 'Cancel';
    cancelBtn.hidden = !!options.infoOnly;
    if (!dialog.open) dialog.showModal();
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.dataset.confirm || form.dataset.confirmed === '1') return;
    e.preventDefault();
    pendingForm = form;
    open({
      message: form.dataset.confirm,
      icon: form.dataset.confirmIcon,
      safe: form.dataset.confirmSafe,
      yesLabel: form.dataset.confirmYesLabel,
      cancelLabel: form.dataset.confirmCancelLabel,
    });
  });

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-info-message]');
    if (!trigger) return;
    pendingForm = null;
    pendingResolve = null;
    open({
      message: trigger.dataset.infoMessage,
      icon: trigger.dataset.infoIcon,
      safe: true,
      yesLabel: trigger.dataset.infoOkLabel || 'OK',
      infoOnly: true,
    });
  });

  window.confirmAction = function (options) {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      open(options);
    });
  };

  yesBtn.addEventListener('click', () => {
    dialog.close();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(true);
      return;
    }
    if (pendingForm) {
      pendingForm.dataset.confirmed = '1';
      pendingForm.requestSubmit();
      pendingForm = null;
    }
  });

  cancelBtn.addEventListener('click', () => {
    dialog.close();
    pendingForm = null;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(false);
    }
  });
})();
