// Communication > Email/Text tabs (both portals): filter popup + a
// single select-all checkbox against the member-list checkboxes.
// Filtering runs client-side against the rows already on the page
// (data-role/data-section/data-grade/data-age-group/data-registered, set
// from utils/emailComposer.js's own listRecipientCandidates()) - see
// that module's header comment for why.
//
// A real request: "Remove select all and select none buttons. Instead
// put a check box on the title row of the 1st column. Selecting this
// box checks everyone. Unchecking that box unchecks everyone." This
// replaces every earlier variant of this control across all four list
// pages (Main Admin and Co-op Admin, Email and Text) - Main Admin used
// to have a standalone "Select All" checkbox in the toolbar (no Select
// None, removed by an even earlier request), Co-op Admin used to have
// the original Select All/Select None <button> pair - with one checkbox
// living in the table's own header cell (the first column's <th>) that
// does both jobs: checked selects every currently-visible (filtered)
// row, unchecked clears every currently-visible row.
(function () {
  const table = document.getElementById('email-candidate-table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('[data-email-row]'));
  const countLabel = document.getElementById('email-select-count');
  const selectAllCheckbox = document.getElementById('email-select-all');

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
    const visibleRows = rows.filter((r) => r.style.display !== 'none');
    const checked = visibleRows.filter((r) => r.querySelector('[data-email-checkbox]').checked).length;
    countLabel.textContent = checked === 0 ? 'No recipients selected.' : `${checked} recipient${checked === 1 ? '' : 's'} selected.`;
  }

  Object.values(filterInputs).forEach((input) => input.addEventListener('change', applyFilters));
  document.querySelector('[data-email-filter-clear]').addEventListener('click', () => {
    Object.values(filterInputs).forEach((input) => (input.value = ''));
    applyFilters();
  });

  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', () => {
      rows.forEach((row) => {
        if (row.style.display === 'none') return;
        row.querySelector('[data-email-checkbox]').checked = selectAllCheckbox.checked;
      });
      updateCount();
    });
  }

  table.addEventListener('change', (e) => {
    if (e.target.matches('[data-email-checkbox]')) updateCount();
  });

  updateCount();
})();
