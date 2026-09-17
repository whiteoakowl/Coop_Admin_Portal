// Communication > Email tab (item 12): filter popup + select all/none
// against the member-list checkboxes. Filtering runs client-side against
// the rows already on the page (data-role/data-section/data-grade/
// data-age-group/data-registered, set from utils/emailComposer.js's own
// listRecipientCandidates()) - see that module's header comment for why.
// A later request, Main Admin only: "select all or none should be
// checkboxes not buttons" moved views/main-admin-email.ejs/main-admin-
// text.ejs from a Select All/Select None button pair to a single checkbox
// in the table's own header cell that did both jobs (checked = select
// every visible row, unchecked = clear every visible row). A further real
// request reversed course on that single combined checkbox: "email tab,
// add and select all and select none check boxes, neatly on the same
// row" - two separate checkboxes now, moved out of the table header and
// into the same toolbar row as Filter/Create Email, matching the
// Select-All/Select-None CHECKBOX pair (not buttons) every bulk print
// picker under Design/Print already uses (public/js/design-print-hub.js's
// own wireBulkMemberList) - Select All stays checked once ticked, Select
// None is a momentary action that clears everything (including Select
// All) and un-checks itself right away. Co-op Admin's own admin-
// email.ejs/admin-text.ejs still use the ORIGINAL button pair and share
// this same script, so all three wirings stay supported side by side -
// whichever markup a given page actually has is what fires.
(function () {
  const table = document.getElementById('email-candidate-table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('[data-email-row]'));
  const countLabel = document.getElementById('email-select-count');
  const selectAllCheckbox = document.getElementById('email-select-all');
  const selectNoneCheckbox = document.getElementById('email-select-none');

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

  // A momentary action, not persistent state - checking it clears every
  // visible row (and Select All, if it was checked) then immediately
  // un-checks itself, same as every Select None checkbox under Design/
  // Print already behaves.
  if (selectNoneCheckbox) {
    selectNoneCheckbox.addEventListener('change', () => {
      if (!selectNoneCheckbox.checked) return;
      rows.forEach((row) => {
        if (row.style.display === 'none') return;
        row.querySelector('[data-email-checkbox]').checked = false;
      });
      if (selectAllCheckbox) selectAllCheckbox.checked = false;
      selectNoneCheckbox.checked = false;
      updateCount();
    });
  }

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
