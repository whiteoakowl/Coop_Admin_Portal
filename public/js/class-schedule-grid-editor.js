// Powers the Add/Edit Class Schedule Grid popup's Rooms list (views/
// partials/class-schedule-grid.ejs) - a real request: "opens a pop up to
// allow you to create a new schedule grid, choose a semester/day,
// choose column titles and row titles." Add Room appends a brand new
// row (no oldNames value, so the save route treats it as new, never a
// rename); Remove just deletes the row from the DOM - the save route's
// own saveRoomsForGrid is a full reconcile of whatever rows are still
// present when the form submits, so a removed row simply isn't in that
// list anymore.
document.querySelectorAll('[data-grid-editor-dialog]').forEach((dialog) => {
  const list = dialog.querySelector('[data-grid-editor-rooms]');
  const addBtn = dialog.querySelector('[data-grid-editor-add-room]');
  if (!list || !addBtn) return;

  function wireRemove(row) {
    const removeBtn = row.querySelector('[data-grid-editor-remove-room]');
    if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
  }

  list.querySelectorAll('[data-grid-editor-room-row]').forEach(wireRemove);

  addBtn.addEventListener('click', () => {
    const row = document.createElement('div');
    row.setAttribute('data-grid-editor-room-row', '');
    row.innerHTML =
      '<input type="text" name="newNames" placeholder="e.g. Room 101" />' +
      '<button type="button" class="icon-btn icon-btn-danger" aria-label="Remove room" data-grid-editor-remove-room><svg class="icon"><use href="#icon-trash"/></svg></button>';
    list.appendChild(row);
    wireRemove(row);
    row.querySelector('input').focus();
  });
});
