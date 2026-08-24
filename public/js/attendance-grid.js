// Attendance grid: each P/L/A cell is always editable and auto-saves on
// change (one request per cell, mirrors the Floater Assignments rank
// select's onchange="this.form.submit()" pattern) - there's no separate
// Edit/Save/Cancel step for the grid itself. Dates and roster membership
// are still handled through their own popups (Edit Dates / Add Member).
//
// A select's own data-endpoint (falling back to the admin day/class-tab
// route if omitted) is what lets this same script also drive the kiosk
// Class Check-In "Attendance" screen's own P/L/A editing (a real request:
// "class attendance should allow for manually changing P, L, A just like
// the Monday/Wednesday attendance") - that surface posts to its own PIN-
// gated route (routes/kiosk-class-checkin.js), not an admin-session one,
// but expects the exact same status:<memberId>:<date> body key so this
// file needs no other kiosk-specific branch.
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
        await fetch(sel.dataset.endpoint || `/admin/rosters/${sel.dataset.tab}/attendance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
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
