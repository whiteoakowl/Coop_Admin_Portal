// Family School Planner - Weekly Plan Grid - a real request: "Be able
// to add rows and columns to create plan grid for the week per
// student." Row/column add/delete are plain form posts (full page
// reload, same as every other Family School Management CRUD action);
// only each cell's own text content saves over fetch() on blur, same
// one-request-per-change/no-page-reload shape public/js/family-school-
// attendance.js's own toggle already uses, so typing in one cell never
// reloads the whole grid out from under the parent.
(function () {
  const grid = document.querySelector('[data-fs-planner-grid]');
  if (!grid) return;
  const cellUrl = grid.dataset.cellUrl;

  grid.addEventListener(
    'blur',
    async (e) => {
      const cell = e.target.closest('[data-fs-planner-cell]');
      if (!cell || !grid.contains(cell)) return;
      const rowId = cell.dataset.rowId;
      const columnId = cell.dataset.columnId;
      const content = cell.value;
      if (content === cell.dataset.savedContent) return;
      try {
        await fetch(cellUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: new URLSearchParams({ rowId, columnId, content }).toString(),
        });
        cell.dataset.savedContent = content;
      } catch (err) {
        // Left as typed - the next successful blur will retry saving it.
      }
    },
    true
  );
})();
