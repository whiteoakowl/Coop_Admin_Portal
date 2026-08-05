(function () {
  const searchInput = document.getElementById('schedule-search-input');
  if (!searchInput) return;

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
})();

// Print Cards tab: client-side name filter + select-all, same pattern as
// the Name Tag Designer's Print tab bulk list.
(function () {
  const list = document.getElementById('schedule-print-list');
  if (!list) return;

  const searchInput = document.getElementById('schedule-print-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      list.querySelectorAll('.member-picker-row').forEach((row) => {
        row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
      });
    });
  }

  const selectAll = document.getElementById('schedule-print-select-all-checkbox');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      list.querySelectorAll('.member-picker-row').forEach((row) => {
        if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAll.checked;
      });
    });
  }
})();
