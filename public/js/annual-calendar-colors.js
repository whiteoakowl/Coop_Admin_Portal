// Main Admin Annual Calendar: Edit Calendar Colors dialog - a real
// request: "Add edit calendar colors buttons. This button will allow
// you to set the color for the month row and set the color for the
// days of the week row." Saves via fetch (same AJAX shape public/js/
// annual-calendar-keys.js's own Save Changes button already uses) and
// applies the two colors to the live grid immediately as CSS custom
// properties (public/css/styles.css's own --annual-calendar-month-
// color/--annual-calendar-weekday-color), so the admin sees the result
// without a page reload.
(function () {
  const form = document.getElementById('annual-calendar-colors-form');
  const saveBtn = document.getElementById('annual-calendar-save-colors-btn');
  const grid = document.querySelector('[data-annual-calendar-grid]');
  if (!form || !saveBtn || !grid) return;

  saveBtn.addEventListener('click', async () => {
    const monthRowColor = form.querySelector('[name="monthRowColor"]').value;
    const weekdayRowColor = form.querySelector('[name="weekdayRowColor"]').value;

    saveBtn.disabled = true;
    try {
      const res = await fetch('/main-admin/annual-calendar/colors', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams({ calendarId: form.dataset.calendarId, monthRowColor, weekdayRowColor }).toString(),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not save colors.');

      grid.style.setProperty('--annual-calendar-month-color', monthRowColor);
      grid.style.setProperty('--annual-calendar-weekday-color', weekdayRowColor);
    } catch (err) {
      window.alert(err.message || 'Could not save colors.');
    } finally {
      saveBtn.disabled = false;
    }
  });
})();
