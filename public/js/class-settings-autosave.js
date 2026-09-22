// Schedules > Settings tab (views/admin-schedule.ejs, tab==='settings'):
// each checkbox is its own field on its own class and auto-saves on
// change, one request per toggle - same fetch-on-change pattern
// public/js/attendance-grid.js already uses for the P/L/A grid, just one
// field/value pair instead of a select's whole value. The Semester
// column (data-class-settings-select) is the same per-class auto-save
// route, just a <select> instead of a checkbox - a real request: "on
// individual class settings add dropdown for choosing semester."
(function () {
  const status = document.getElementById('class-settings-save-status');
  const toggles = document.querySelectorAll('[data-class-settings-toggle]');
  const selects = document.querySelectorAll('[data-class-settings-select]');
  if (toggles.length === 0 && selects.length === 0) return;

  async function save(classId, field, value) {
    const res = await fetch(`/admin/class-schedule/classes/${classId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      body: new URLSearchParams({ field, value }).toString(),
    });
    if (!res.ok) throw new Error('save failed');
  }

  toggles.forEach((box) => {
    box.addEventListener('change', async () => {
      const checked = box.checked;
      if (status) status.textContent = 'Saving…';
      try {
        await save(box.dataset.classId, box.dataset.field, checked ? '1' : '0');
        if (status) status.textContent = 'Saved';
      } catch (err) {
        box.checked = !checked;
        if (status) status.textContent = 'Connection error saving - change reverted.';
      }
    });
  });

  selects.forEach((select) => {
    select.addEventListener('change', async () => {
      const previousValue = select.dataset.previousValue || '';
      if (status) status.textContent = 'Saving…';
      try {
        await save(select.dataset.classId, select.dataset.field, select.value);
        select.dataset.previousValue = select.value;
        if (status) status.textContent = 'Saved';
      } catch (err) {
        select.value = previousValue;
        if (status) status.textContent = 'Connection error saving - change reverted.';
      }
    });
    select.dataset.previousValue = select.value;
  });
})();
