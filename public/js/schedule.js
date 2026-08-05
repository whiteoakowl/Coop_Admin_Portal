(function () {
  const table = document.getElementById('schedule-table');
  if (!table) return;

  const selectAll = document.getElementById('schedule-select-all');
  const rowChecks = () => Array.prototype.slice.call(table.querySelectorAll('.schedule-row-check'));
  const checkedIds = () => rowChecks().filter((c) => c.checked).map((c) => c.value);

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      rowChecks().forEach((c) => { c.checked = selectAll.checked; });
    });
  }

  const editBtn = document.getElementById('schedule-edit-btn');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const ids = checkedIds();
      if (ids.length !== 1) return alert('Select exactly one member to edit.');
      window.location = '/admin/schedule/member/' + ids[0] + '/manage';
    });
  }

  const deleteBtn = document.getElementById('schedule-delete-btn');
  const deleteForm = document.getElementById('schedule-delete-form');
  if (deleteBtn && deleteForm) {
    deleteBtn.addEventListener('click', () => {
      const ids = checkedIds();
      if (ids.length === 0) return alert('Select at least one member first.');
      if (!confirm('Clear the schedule for ' + ids.length + ' selected member(s)? This cannot be undone.')) return;
      deleteForm.innerHTML = '';
      ids.forEach((id) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'memberIds';
        input.value = id;
        deleteForm.appendChild(input);
      });
      deleteForm.submit();
    });
  }

  const duplicateBtn = document.getElementById('schedule-duplicate-btn');
  const duplicateDialog = document.getElementById('duplicate-dialog');
  const duplicateFromInput = document.getElementById('duplicate-from-member-id');
  if (duplicateBtn && duplicateDialog && duplicateFromInput) {
    duplicateBtn.addEventListener('click', () => {
      const ids = checkedIds();
      if (ids.length !== 1) return alert('Select exactly one member to duplicate a schedule from.');
      duplicateFromInput.value = ids[0];
      duplicateDialog.showModal();
    });
  }

  const searchInput = document.getElementById('schedule-search-input');
  if (searchInput) {
    let timer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const url = new URL(window.location.href);
        if (searchInput.value) url.searchParams.set('search', searchInput.value);
        else url.searchParams.delete('search');
        url.searchParams.delete('page');
        window.location = url.toString();
      }, 500);
    });
  }
})();
