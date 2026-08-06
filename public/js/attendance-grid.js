// Attendance grid Edit/Save toggle: unlike the generic edit-toggle.js
// (single form/inputs), this page also has to reveal an "Edit Session
// Dates" button and a per-row Remove button, and batches every changed
// cell into one POST on Save (mirrors public/js/volunteer-assignments.js).
(function () {
  const editBtn = document.getElementById('roster-edit-btn');
  if (!editBtn) return;

  const cancelBtn = document.getElementById('roster-cancel-btn');
  const saveBtn = document.getElementById('roster-save-btn');
  const editDatesBtn = document.getElementById('roster-edit-dates-btn');
  const status = document.getElementById('roster-save-status');
  const selects = document.querySelectorAll('.roster-cell-select');
  const removeBtns = document.querySelectorAll('.roster-remove-btn');
  const tab = editBtn.dataset.tab;

  function setEditing(on) {
    selects.forEach((sel) => { sel.disabled = !on; });
    removeBtns.forEach((btn) => { btn.hidden = !on; });
    if (editDatesBtn) editDatesBtn.hidden = !on;
    editBtn.hidden = on;
    if (cancelBtn) cancelBtn.hidden = !on;
    if (saveBtn) saveBtn.hidden = !on;
  }

  editBtn.addEventListener('click', () => setEditing(true));

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      selects.forEach((sel) => { sel.value = sel.dataset.original; });
      setEditing(false);
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const body = new URLSearchParams();
      selects.forEach((sel) => {
        body.set(`status:${sel.dataset.member}:${sel.dataset.date}`, sel.value);
      });

      if (status) status.textContent = 'Saving…';
      try {
        await fetch(`/admin/rosters/${tab}/attendance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (status) status.textContent = 'Saved';
      } catch (err) {
        if (status) status.textContent = 'Connection error saving.';
      }

      selects.forEach((sel) => { sel.dataset.original = sel.value; });
      setEditing(false);
    });
  }
})();
