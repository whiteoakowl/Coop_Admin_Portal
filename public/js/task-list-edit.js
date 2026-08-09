// Task List tab (Setup/Cleanup): the whole page starts view-only -
// clicking Edit unlocks every list title/task description input in
// place and reveals the reorder/delete controls + the top-right Save
// button, which submits all the title/description text in one POST
// (reordering and deleting are their own immediate actions, not part of
// that submit - see routes/admin-setup.js).
(function () {
  const editBtn = document.querySelector('[data-task-list-edit-btn]');
  const saveBtn = document.querySelector('[data-task-list-save-btn]');
  const form = document.querySelector('[data-task-list-form]');
  if (!editBtn || !form) return;

  editBtn.addEventListener('click', () => {
    form.querySelectorAll('[data-task-list-input]').forEach((el) => { el.readOnly = false; });
    document.querySelectorAll('[data-task-list-edit-only]').forEach((el) => { el.hidden = false; });
    document.querySelectorAll('.task-list-team-badge').forEach((el) => { el.hidden = true; });
    editBtn.hidden = true;
    if (saveBtn) saveBtn.hidden = false;
  });
})();
