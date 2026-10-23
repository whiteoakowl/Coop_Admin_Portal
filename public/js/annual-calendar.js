// Main Admin Annual Calendar - a real request: "Create key button...
// Be able to click each key then click on the calendar dates to color/
// key each one that particular key. Click on a new key and repeat the
// process." Clicking a key button selects it (toggling .active, one at a
// time); clicking a calendar date while a key is selected posts the
// toggle endpoint (routes/main-admin-annual-calendar.js) and recolors
// that one cell from the response - same one-request-per-click/no-page-
// reload shape public/js/family-school-attendance.js already uses.
(function () {
  const keyBar = document.querySelector('[data-annual-calendar-key-bar]');
  const grid = document.querySelector('[data-annual-calendar-grid]');
  if (!keyBar || !grid) return;
  const toggleUrl = grid.dataset.toggleUrl;
  const calendarId = grid.dataset.calendarId;
  let activeKeyBtn = null;

  keyBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-annual-calendar-key-btn]');
    if (!btn || !keyBar.contains(btn)) return;
    if (activeKeyBtn === btn) {
      btn.classList.remove('active');
      activeKeyBtn = null;
      return;
    }
    if (activeKeyBtn) activeKeyBtn.classList.remove('active');
    btn.classList.add('active');
    activeKeyBtn = btn;
  });

  grid.addEventListener('click', async (e) => {
    const cell = e.target.closest('[data-annual-calendar-day]');
    if (!cell || !grid.contains(cell)) return;
    if (!activeKeyBtn) return;
    const date = cell.dataset.date;
    const keyId = activeKeyBtn.dataset.keyId;
    cell.classList.add('fs-attendance-day-saving');
    try {
      const res = await fetch(toggleUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams({ calendarId, date, keyId }).toString(),
      });
      const data = await res.json();
      cell.classList.remove('fs-attendance-day-saving');
      cell.style.backgroundColor = data.key ? data.key.color : '';
    } catch (err) {
      cell.classList.remove('fs-attendance-day-saving');
    }
  });
})();
