// A member must stay on at least one hour section - checked on Save
// instead of on every checkbox click, since hours are now edited behind
// an explicit Edit/Save toggle rather than autosaving per click.
function volunteerValidateHours(form) {
  const anyChecked = form.querySelectorAll('input[type="checkbox"]:checked').length > 0;
  if (!anyChecked) {
    alert('A member needs at least one hour. Use Remove to take them off the list entirely.');
    return false;
  }
  return true;
}

// Position/room grid: Edit unlocks every cell (public/js/edit-toggle.js
// handles that generically); Save Changes here batches every cell into
// one POST instead of a fetch per field.
(function () {
  const form = document.getElementById('volunteer-grid-form');
  if (!form) return;
  const saveBtn = form.querySelector('[data-edit-toggle-save]');
  const cancelBtn = form.querySelector('[data-edit-toggle-cancel]');
  const editBtn = form.querySelector('[data-edit-toggle-edit]');
  const status = document.getElementById('volunteer-save-status');
  if (!saveBtn) return;

  saveBtn.addEventListener('click', async () => {
    const inputs = form.querySelectorAll('.volunteer-cell-input[data-field]');
    if (!inputs.length) return;
    const day = inputs[0].dataset.day;
    const body = new URLSearchParams();
    inputs.forEach((input) => {
      const key = input.dataset.field + ':' + input.dataset.member + ':' + input.dataset.date;
      body.set(key, input.value);
    });

    if (status) status.textContent = 'Saving…';
    try {
      await fetch('/admin/volunteers/' + day + '/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (status) status.textContent = 'Saved';
    } catch (err) {
      if (status) status.textContent = 'Connection error saving.';
    }

    inputs.forEach((input) => {
      input.disabled = true;
      input.defaultValue = input.value;
    });
    saveBtn.hidden = true;
    if (cancelBtn) cancelBtn.hidden = true;
    if (editBtn) editBtn.hidden = false;
  });
})();
