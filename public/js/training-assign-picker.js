// Assign Training member picker (admin-training-assign.ejs) - a filter
// dropdown (All/Students/Primary Parents/Parents/Admins/Teachers) plus
// Select All/Select None, same interaction as the Design/Print hub's own
// bulk print pickers (public/js/design-print-hub.js's wireBulkMemberList)
// - standalone here since this page doesn't otherwise load that script. A
// real request: "should have a filter option like bulk printing. primary
// parents, parents, students, admins" (teachers added as a follow-up to
// that same request).
(function () {
  const list = document.getElementById('training-assign-list');
  if (!list) return;

  const filterSelect = document.getElementById('training-assign-filter-select');
  function applyFilter() {
    const filter = filterSelect ? filterSelect.value : 'all';
    list.querySelectorAll('.print-picker-row').forEach((row) => {
      const matches =
        filter === 'all' ||
        (filter === 'teacher' ? row.dataset.teacher === '1' : filter === 'primaryParent' ? row.dataset.primary === '1' : row.dataset.type === filter);
      row.style.display = matches ? '' : 'none';
    });
  }
  if (filterSelect) filterSelect.addEventListener('change', applyFilter);

  const selectAll = document.getElementById('training-assign-select-all-checkbox');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      list.querySelectorAll('.print-picker-row').forEach((row) => {
        if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAll.checked;
      });
    });
  }

  const selectNone = document.getElementById('training-assign-select-none-checkbox');
  if (selectNone) {
    selectNone.addEventListener('change', () => {
      if (selectNone.checked) {
        list.querySelectorAll('.print-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
        });
        if (selectAll) selectAll.checked = false;
        selectNone.checked = false;
      }
    });
  }
})();
