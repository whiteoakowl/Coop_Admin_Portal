// A real request: "Add bulk edit button on classes, class schedules...
// When you click bulk edit it will show a check mark on the left next to
// each member in list view and a select all button. Bulk edit button
// then says bulk edit selected classes." Deliberately its own small
// script rather than reusing archive-select-toggle.js's generic toggle:
// that script treats every click on its own toggle button as flipping
// selection mode on/off, but this button needs a THIRD state - once
// selection mode is on and at least one class is checked, clicking the
// (now relabeled) button again should open the bulk-edit dialog, not
// cancel out of selection mode. Select All itself (data-select-all-for)
// is still handled by archive-select-toggle.js, already loaded on this
// same page - that part really is generic and shared as-is.
(function () {
  if (window.__classScheduleBulkEditInstalled) return;
  window.__classScheduleBulkEditInstalled = true;

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-bulk-edit-toggle]');
    if (!toggle) return;
    const formId = toggle.getAttribute('data-bulk-edit-toggle');
    const controls = document.querySelector(`[data-bulk-edit-controls="${formId}"]`);
    const checkboxes = document.querySelectorAll(`input[type="checkbox"][form="${formId}"]`);
    if (!controls) return;

    if (controls.hidden) {
      controls.hidden = false;
      checkboxes.forEach((cb) => { cb.hidden = false; });
      toggle.textContent = 'Bulk Edit Selected Classes';
      toggle.setAttribute('aria-pressed', 'true');
      return;
    }

    const checkedIds = Array.from(checkboxes).filter((cb) => cb.checked).map((cb) => cb.value);
    if (checkedIds.length === 0) {
      // Nothing picked yet - treat a second click as Cancel instead of
      // opening an empty bulk-edit form with nothing to apply it to.
      controls.hidden = true;
      checkboxes.forEach((cb) => { cb.hidden = true; cb.checked = false; });
      const selectAll = controls.querySelector('[data-select-all-for]');
      if (selectAll) selectAll.checked = false;
      toggle.textContent = 'Bulk Edit';
      toggle.setAttribute('aria-pressed', 'false');
      return;
    }

    const dialog = document.getElementById(toggle.getAttribute('data-bulk-edit-dialog'));
    if (!dialog) return;
    const idsField = dialog.querySelector('[data-bulk-edit-ids]');
    if (idsField) idsField.value = checkedIds.join(',');
    const countEl = dialog.querySelector('[data-bulk-edit-count]');
    if (countEl) countEl.textContent = String(checkedIds.length);
    dialog.showModal();
  });

  // "Open Class"/"Close Class" are two separate checkboxes (a real
  // request: "open and close class check boxes"), not one toggle, but a
  // class obviously can't be bulk-set to both at once - checking one
  // unchecks the other.
  document.addEventListener('change', (e) => {
    const box = e.target.closest('input[name="openClass"], input[name="closeClass"]');
    if (!box || !box.checked) return;
    const form = box.closest('form');
    if (!form) return;
    const other = form.querySelector(`input[name="${box.name === 'openClass' ? 'closeClass' : 'openClass'}"]`);
    if (other) other.checked = false;
  });
})();
