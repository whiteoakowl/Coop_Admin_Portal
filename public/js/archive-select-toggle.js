// Powers every "Archive" toggle button (Class Schedule grid, Student/
// Parent Schedules grid): each starts with just a plain "Archive" button -
// clicking it (data-archive-toggle="<formId>") reveals the matching
// [data-archive-controls="<formId>"] block (Select All + Archive Selected,
// usually placed under the page's own filter row) and every checkbox
// associated with that same form (form="<formId>"), and relabels itself
// "Cancel". Clicking it again hides all of that again and clears the
// selection, so leaving selection mode never leaves stray checked boxes
// behind for next time.
//   - "Select All" (data-select-all-for="<formId>") toggles every
//     checkbox associated with the same form, since those checkboxes live
//     inside cards rather than the form itself.
(function () {
  if (window.__archiveSelectToggleInstalled) return;
  window.__archiveSelectToggleInstalled = true;

  document.addEventListener('change', (e) => {
    const master = e.target.closest('[data-select-all-for]');
    if (!master) return;
    const formId = master.getAttribute('data-select-all-for');
    document.querySelectorAll(`input[type="checkbox"][form="${formId}"]`).forEach((cb) => {
      cb.checked = master.checked;
    });
  });

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-archive-toggle]');
    if (!toggle) return;
    const formId = toggle.getAttribute('data-archive-toggle');
    const controls = document.querySelector(`[data-archive-controls="${formId}"]`);
    const checkboxes = document.querySelectorAll(`input[type="checkbox"][form="${formId}"]`);
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
