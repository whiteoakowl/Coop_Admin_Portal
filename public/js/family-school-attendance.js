// Family School Attendance calendar - a real request: "View a calendar
// and mark days student is present for school by clicking on the date
// and it highlights gren. If you click again it becomes red for didn't
// do school." Each click fetch()es the toggle endpoint (routes/parent-
// family-school.js's own POST .../attendance/:studentId/toggle) and
// recolors that one cell from the response, same one-request-per-click/
// no-page-reload shape public/js/attendance-grid.js already uses.
(function () {
  const calendar = document.querySelector('[data-fs-attendance-calendar]');
  if (!calendar) return;
  const toggleUrl = calendar.dataset.toggleUrl;

  calendar.addEventListener('click', async (e) => {
    const cell = e.target.closest('[data-fs-attendance-cell]');
    if (!cell || !calendar.contains(cell)) return;
    const date = cell.dataset.date;
    cell.classList.add('fs-attendance-day-saving');
    try {
      const res = await fetch(toggleUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams({ date }).toString(),
      });
      const data = await res.json();
      cell.classList.remove('fs-attendance-day-saving', 'fs-attendance-day-present', 'fs-attendance-day-absent', 'fs-attendance-day-unmarked');
      cell.classList.add('fs-attendance-day-' + (data.status || 'unmarked'));
    } catch (err) {
      cell.classList.remove('fs-attendance-day-saving');
    }
  });
})();
