// Family School Management > Annual Planner - a real request: "Add
// edit and delete icons to all annual planning curriculum rows that are
// added... No refresh page when delete, it simple disappears and you
// can keep view the same page and same spot." Same window.confirmAction
// + fetch()-then-remove-the-row pattern as public/js/edit-families.js's
// own Delete Family button. The Edit dialog is one shared dialog (not
// one per row), populated from the clicked row's own Edit button data-*
// attributes and with its form action pointed at that row's own edit
// route before it's shown.
(function () {
  const editDialog = document.getElementById('edit-curriculum-dialog');
  const editForm = document.getElementById('edit-curriculum-form');

  document.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-curriculum]');
    if (editBtn && editDialog && editForm) {
      editForm.action = `/parent/family-school/annual-planner/${editBtn.getAttribute('data-edit-curriculum')}/edit`;
      editForm.querySelector('[name="subject"]').value = editBtn.dataset.subject || '';
      editForm.querySelector('[name="name"]').value = editBtn.dataset.name || '';
      editForm.querySelector('[name="brand"]').value = editBtn.dataset.brand || '';
      editForm.querySelector('[name="level"]').value = editBtn.dataset.level || '';
      editForm.querySelector('[name="price"]').value = editBtn.dataset.price || '';
      const yearSelect = editForm.querySelector('[name="schoolYear"]');
      if (yearSelect && editBtn.dataset.schoolYear) yearSelect.value = editBtn.dataset.schoolYear;
      editDialog.showModal();
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-curriculum]');
    if (!deleteBtn) return;
    const id = deleteBtn.getAttribute('data-delete-curriculum');
    const name = deleteBtn.dataset.curriculumName || '';
    const studentName = deleteBtn.dataset.studentName || '';
    const confirmed = await window.confirmAction({
      message: `Remove "${name}" from ${studentName}'s curriculum?`,
      yesLabel: 'Yes, Delete',
    });
    if (!confirmed) return;

    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/parent/family-school/annual-planner/${id}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not remove curriculum item.');

      const row = document.querySelector(`tr[data-curriculum-id="${id}"]`);
      const section = row && row.closest('[data-curriculum-section]');
      if (row) row.remove();
      if (section) {
        const tbody = section.querySelector('tbody');
        const emptyMessage = section.querySelector('[data-curriculum-empty]');
        const scroll = section.querySelector('.roster-scroll');
        if (tbody && !tbody.querySelector('tr') && emptyMessage && scroll) {
          scroll.hidden = true;
          emptyMessage.hidden = false;
        }
      }
    } catch (err) {
      deleteBtn.disabled = false;
      window.alert(err.message || 'Could not remove curriculum item.');
    }
  });
})();
