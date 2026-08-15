// Drag-and-drop reordering of the Class Schedule grid's room rows -
// grabbing a row's handle (.room-row-drag-handle) and moving it up/down
// saves a custom per-day room order (routes/admin-class-schedule.js's
// POST /class-schedule/:day/rooms/reorder -> getRoomOrder/saveRoomOrder
// in utils/classSchedule.js), instead of the grid always sorting rooms
// alphabetically. Pointer Events (not mousedown/mousemove/mouseup) so
// this works with a touch drag on mobile too, same reasoning as the Name
// Tag/Schedule Card design editors' own drag handling.
(function () {
  if (window.__roomRowReorderInstalled) return;
  window.__roomRowReorderInstalled = true;

  let dragging = null; // { row, table }

  function rowsIn(table) {
    return Array.from(table.querySelectorAll('tbody tr[data-room-row]'));
  }

  // The row a pointer at `y` should be dropped in front of, or null to
  // drop at the very end.
  function rowAtY(table, y) {
    const rows = rowsIn(table).filter((r) => r !== dragging.row);
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return row;
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.room-row-drag-handle');
    if (!handle) return;
    const row = handle.closest('tr[data-room-row]');
    const table = handle.closest('table[data-room-reorder-day]');
    if (!row || !table) return;
    e.preventDefault();
    dragging = { row, table };
    handle.setPointerCapture(e.pointerId);
    row.classList.add('room-row-dragging');
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const tbody = dragging.table.querySelector('tbody');
    const target = rowAtY(dragging.table, e.clientY);
    if (target) tbody.insertBefore(dragging.row, target);
    else tbody.appendChild(dragging.row);
  });

  document.addEventListener('pointerup', async () => {
    if (!dragging) return;
    const { row, table } = dragging;
    row.classList.remove('room-row-dragging');
    dragging = null;

    const day = table.getAttribute('data-room-reorder-day');
    const rooms = rowsIn(table).map((r) => r.getAttribute('data-room-row'));
    try {
      await fetch(`/admin/class-schedule/${day}/rooms/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: JSON.stringify({ rooms }),
      });
    } catch (err) {
      // Reordering is a nice-to-have, not page-breaking - if this fails
      // (offline, session expired), the on-screen order just reverts to
      // alphabetical on the next full page load instead of interrupting
      // the admin with an error for a drag they already finished.
    }
  });
})();
