// Weekly Planner (views/parent-family-school-weekly-planner.ejs) - a
// real request: "Add edit icon and delete to all weekly planner
// assignments. No refresh page when delete, it simple disappears and
// you can keep view the same page and same spot." Same
// window.confirmAction + fetch()-then-remove-the-row pattern as public/
// js/edit-families.js's own Delete Family button (and Annual Planner's
// own public/js/annual-planner-curriculum.js). The Edit dialog is one
// shared dialog (not one per assignment), populated from the clicked
// assignment's own Edit button data-* attributes and with its form
// action pointed at that assignment's own edit route before it's shown.
(function () {
  const editDialog = document.getElementById('edit-assignment-dialog');
  const editForm = document.getElementById('edit-assignment-form');

  function setZoneEmptyState(zone) {
    const list = zone.querySelector('.fs-weekly-plan-assignment-list');
    const hint = zone.querySelector('.fs-weekly-plan-empty-hint');
    const hasItems = list && list.querySelector('li');
    if (list) list.hidden = !hasItems;
    if (hint) hint.hidden = Boolean(hasItems);
  }

  document.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-assignment]');
    if (editBtn && editDialog && editForm) {
      editForm.action = `/parent/family-school/weekly-planner/assignments/${editBtn.getAttribute('data-edit-assignment')}/edit`;
      editForm.querySelector('[name="title"]').value = editBtn.dataset.title || '';
      editForm.querySelector('[name="subject"]').value = editBtn.dataset.subject || '';
      editForm.querySelector('[name="description"]').value = editBtn.dataset.description || '';
      editForm.querySelector('[name="link"]').value = editBtn.dataset.link || '';
      editForm.querySelector('[name="grade"]').value = editBtn.dataset.grade || '';
      editDialog.showModal();
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-assignment]');
    if (!deleteBtn) return;
    const id = deleteBtn.getAttribute('data-delete-assignment');
    const title = deleteBtn.dataset.assignmentTitle || '';
    const confirmed = await window.confirmAction({
      message: `Delete the assignment "${title}"?`,
      yesLabel: 'Yes, Delete',
    });
    if (!confirmed) return;

    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/parent/family-school/weekly-planner/assignments/${id}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not delete assignment.');

      const li = document.querySelector(`li[data-assignment-id="${id}"]`);
      const zone = li && li.closest('.fs-weekly-plan-dropzone');
      if (li) li.remove();
      if (zone) setZoneEmptyState(zone);
    } catch (err) {
      deleteBtn.disabled = false;
      window.alert(err.message || 'Could not delete assignment.');
    }
  });
})();
