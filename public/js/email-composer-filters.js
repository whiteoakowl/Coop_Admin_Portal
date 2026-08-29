// Communication > Email tab (item 12): filter popup + select all/none
// against the member-list checkboxes. Filtering runs client-side against
// the rows already on the page (data-role/data-section/data-grade/
// data-age-group/data-registered, set from utils/emailComposer.js's own
// listRecipientCandidates()) - see that module's header comment for why.
(function () {
  const table = document.getElementById('email-candidate-table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('[data-email-row]'));
  const countLabel = document.getElementById('email-select-count');

  const filterInputs = {
    role: document.getElementById('email-filter-role'),
    section: document.getElementById('email-filter-section'),
    grade: document.getElementById('email-filter-grade'),
    age: document.getElementById('email-filter-age'),
    registered: document.getElementById('email-filter-registered'),
  };

  function rowMatches(row) {
    if (filterInputs.role.value && !row.dataset.role.split(',').includes(filterInputs.role.value)) return false;
    if (filterInputs.section.value && !row.dataset.section.split('|').includes(filterInputs.section.value)) return false;
    if (filterInputs.grade.value && row.dataset.grade !== filterInputs.grade.value) return false;
    if (filterInputs.age.value && row.dataset.ageGroup !== filterInputs.age.value) return false;
    if (filterInputs.registered.value && row.dataset.registered !== filterInputs.registered.value) return false;
    return true;
  }

  function applyFilters() {
    rows.forEach((row) => {
      const visible = rowMatches(row);
      row.style.display = visible ? '' : 'none';
      if (!visible) row.querySelector('[data-email-checkbox]').checked = false;
    });
    updateCount();
  }

  function updateCount() {
    const checked = rows.filter((r) => r.querySelector('[data-email-checkbox]').checked).length;
    countLabel.textContent = checked === 0 ? 'No recipients selected.' : `${checked} recipient${checked === 1 ? '' : 's'} selected.`;
  }

  Object.values(filterInputs).forEach((input) => input.addEventListener('change', applyFilters));
  document.querySelector('[data-email-filter-clear]').addEventListener('click', () => {
    Object.values(filterInputs).forEach((input) => (input.value = ''));
    applyFilters();
  });

  document.querySelectorAll('[data-email-select]').forEach((button) => {
    button.addEventListener('click', () => {
      const selectAll = button.dataset.emailSelect === 'all';
      rows.forEach((row) => {
        if (row.style.display === 'none') return;
        row.querySelector('[data-email-checkbox]').checked = selectAll;
      });
      updateCount();
    });
  });

  table.addEventListener('change', (e) => {
    if (e.target.matches('[data-email-checkbox]')) updateCount();
  });

  updateCount();
})();
