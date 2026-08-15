// Powers the Class Schedule grid's "Archive" flow:
//   - The "Archive" button (data-archive-toggle="<day>") starts hidden -
//     clicking it reveals each class card's own checkbox plus the "Select
//     All"/"Archive Selected" controls (in the filter row, under
//     "Highlight Absences For"), and relabels itself "Cancel". Clicking it
//     again (now "Cancel") hides all of that again and clears any
//     selection, so leaving selection mode never leaves stray checked
//     boxes behind for next time.
//   - "Select All" toggles every per-class checkbox associated (via the
//     HTML form="..." attribute) with the same archive form, since those
//     checkboxes live inside table cells rather than the form itself.
(function () {
  if (window.__classScheduleArchiveSelectInstalled) return;
  window.__classScheduleArchiveSelectInstalled = true;

  document.addEventListener('change', (e) => {
    const master = e.target.closest('[data-select-all-for]');
    if (!master) return;
    const formId = master.getAttribute('data-select-all-for');
    document.querySelectorAll(`input[name="classIds"][form="${formId}"]`).forEach((cb) => {
      cb.checked = master.checked;
    });
  });

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-archive-toggle]');
    if (!toggle) return;
    const day = toggle.getAttribute('data-archive-toggle');
    const controls = document.getElementById(`class-schedule-archive-controls-${day}`);
    const formId = `class-archive-form-${day}`;
    const checkboxes = document.querySelectorAll(`input.class-card-checkbox[form="${formId}"]`);
    if (!controls) return;

    const activating = controls.hidden;
    controls.hidden = !activating;
    checkboxes.forEach((cb) => {
      cb.hidden = !activating;
      if (!activating) cb.checked = false;
    });
    if (!activating) {
      const selectAll = controls.querySelector('[data-select-all-for]');
      if (selectAll) selectAll.checked = false;
    }
    toggle.textContent = activating ? 'Cancel' : 'Archive';
    toggle.setAttribute('aria-pressed', String(activating));
  });
})();
