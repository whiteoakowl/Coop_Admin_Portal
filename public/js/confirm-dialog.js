// Sitewide "are you sure you want to delete?" popup, replacing the
// browser's native confirm() everywhere. Any <form data-confirm="..."> is
// intercepted on submit (event delegation - works for forms injected
// later via fetch too, e.g. class-schedule-view-fragment.ejs) and shown
// this dialog instead; "Yes, Delete" re-submits the same form (marking it
// confirmed first so the listener doesn't just intercept it again),
// Cancel closes without doing anything.
//
// A form submitted purely from JS via form.submit() never fires a submit
// event at all (a DOM quirk) - anywhere that used to do that now calls
// form.requestSubmit() instead, specifically so this still catches it
// (see admin-members.ejs's Delete member button).
(function () {
  const dialog = document.getElementById('confirm-dialog');
  if (!dialog) return;
  const messageEl = document.getElementById('confirm-dialog-message');
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
