// Attendance grid: each P/L/A cell is always editable and auto-saves on
// change (one request per cell, mirrors the Floater Assignments rank
// select's onchange="this.form.submit()" pattern) - there's no separate
// Edit/Save/Cancel step for the grid itself. Dates and roster membership
// are still handled through their own popups (Edit Dates / Add Member).
(function () {
  const status = document.getElementById('roster-save-status');
  const selects = document.querySelectorAll('.roster-cell-select');
  if (selects.length === 0) return;

  selects.forEach((sel) => {
    sel.addEventListener('change', async () => {
      const body = new URLSearchParams();
      body.set(`status:${sel.dataset.member}:${sel.dataset.date}`, sel.value);
      sel.className = 'roster-cell-select roster-cell-select-' + (sel.value || 'blank');

      if (status) status.textContent = 'Saving…';
      try {
        await fetch(`/admin/rosters/${sel.dataset.tab}/attendance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
          body: body.toString(),
        });
        if (status) status.textContent = 'Saved';
        sel.dataset.original = sel.value;
      } catch (err) {
        if (status) status.textContent = 'Connection error saving.';
      }
    });
  });
})();
