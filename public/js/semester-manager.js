// Add/Edit Semester - clicking a semester's own title swaps in an inline
// edit row below it (title input + day checkboxes + Save/Cancel), rather
// than the list staying static. A real request: "clicking on the
// semester title you can edit the title and days checked, save."
(function () {
  document.addEventListener('click', function (e) {
    const toggleBtn = e.target.closest('[data-semester-edit-toggle]');
    if (toggleBtn) {
      const row = document.getElementById(toggleBtn.dataset.semesterEditToggle);
      if (row) row.hidden = !row.hidden;
      return;
    }
    const cancelBtn = e.target.closest('[data-semester-edit-cancel]');
    if (cancelBtn) {
      const row = document.getElementById(cancelBtn.dataset.semesterEditCancel);
      if (row) {
        row.hidden = true;
        const form = row.querySelector('form');
        if (form) form.reset();
      }
    }
  });
})();
