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
(function () {
  const dialog = document.getElementById('confirm-dialog');
  if (!dialog) return;
  const messageEl = document.getElementById('confirm-dialog-message');
  const iconEl = dialog.querySelector('.confirm-dialog-icon');
  const iconUse = iconEl.querySelector('use');
  const yesBtn = dialog.querySelector('[data-confirm-yes]');
  const cancelBtn = dialog.querySelector('[data-confirm-cancel]');
  let pendingForm = null;

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.dataset.confirm || form.dataset.confirmed === '1') return;
    e.preventDefault();
    pendingForm = form;
    messageEl.textContent = form.dataset.confirm;
    iconUse.setAttribute('href', `#${form.dataset.confirmIcon || 'icon-trash'}`);
    iconEl.classList.toggle('confirm-icon-safe', !!form.dataset.confirmSafe);
    yesBtn.textContent = form.dataset.confirmYesLabel || 'Yes, Delete';
    yesBtn.classList.toggle('primary-btn', !!form.dataset.confirmSafe);
    yesBtn.classList.toggle('roster-action-btn-danger', !form.dataset.confirmSafe);
    if (!dialog.open) dialog.showModal();
  });

  yesBtn.addEventListener('click', () => {
    dialog.close();
    if (pendingForm) {
      pendingForm.dataset.confirmed = '1';
      pendingForm.requestSubmit();
      pendingForm = null;
    }
  });

  cancelBtn.addEventListener('click', () => {
    dialog.close();
    pendingForm = null;
  });
})();
