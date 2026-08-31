// Schedules > Settings tab (views/admin-schedule.ejs, tab==='settings'):
// each checkbox is its own field on its own class and auto-saves on
// change, one request per toggle - same fetch-on-change pattern
// public/js/attendance-grid.js already uses for the P/L/A grid, just one
// field/value pair instead of a select's whole value.
(function () {
  const status = document.getElementById('class-settings-save-status');
  const toggles = document.querySelectorAll('[data-class-settings-toggle]');
  if (toggles.length === 0) return;

  toggles.forEach((box) => {
    box.addEventListener('change', async () => {
      const classId = box.dataset.classId;
      const field = box.dataset.field;
      const checked = box.checked;
      if (status) status.textContent = 'Saving…';
      try {
        const res = await fetch(`/admin/class-schedule/classes/${classId}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: new URLSearchParams({ field, value: checked ? '1' : '0' }).toString(),
        });
        if (!res.ok) throw new Error('save failed');
        if (status) status.textContent = 'Saved';
      } catch (err) {
        box.checked = !checked;
        if (status) status.textContent = 'Connection error saving - change reverted.';
      }
    });
  });
})();
