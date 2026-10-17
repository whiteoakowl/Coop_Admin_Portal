// Powers the Edit Schedule Grids popup's Rooms (rows) and Hours
// (columns) lists (views/partials/class-schedule-grid.ejs) - a real
// request: "opens a pop up to allow you to create a new schedule grid,
// choose a semester/day, choose column titles and row titles." Add Row
// appends a brand new room row (no oldNames value, so the save route
// treats it as new, never a rename); Remove just deletes the row from
// the DOM - the save route's own saveRoomsForGrid is a full reconcile of
// whatever rows are still present when the form submits, so a removed
// row simply isn't in that list anymore.
document.querySelectorAll('[data-grid-editor-dialog]').forEach((dialog) => {
  const list = dialog.querySelector('[data-grid-editor-rooms]');
  const addBtn = dialog.querySelector('[data-grid-editor-add-room]');
  if (list && addBtn) {
    function wireRemove(row) {
      const removeBtn = row.querySelector('[data-grid-editor-remove-room]');
      if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
    }

    list.querySelectorAll('[data-grid-editor-room-row]').forEach(wireRemove);

    addBtn.addEventListener('click', () => {
      const row = document.createElement('div');
      row.setAttribute('data-grid-editor-room-row', '');
      row.innerHTML =
        '<input type="text" class="edit-hour-title-input" name="newNames" placeholder="e.g. Room 101" />' +
        '<button type="button" class="icon-btn icon-btn-danger" aria-label="Remove room" data-grid-editor-remove-room><svg class="icon"><use href="#icon-trash"/></svg></button>';
      list.appendChild(row);
      wireRemove(row);
      row.querySelector('input').focus();
    });
  }

  // A real request: "Add column and add row buttons" - "+ Add Column"
  // appends a brand new blank hour block (no existing label/start/end
  // value) to the same .edit-hours-grid every existing hour already
  // renders into. Nothing but DOM here - saveHourLabels (utils/
  // classSchedule.js) is what actually notices the submitted labels[]
  // array grew past the shared HOUR_POSITIONS count and grows that
  // shared count for every day/grid at once once Save is clicked.
  const hoursGrid = dialog.querySelector('.edit-hours-grid');
  const addColumnBtn = dialog.querySelector('[data-grid-editor-add-column]');
  if (hoursGrid && addColumnBtn) {
    addColumnBtn.addEventListener('click', () => {
      const position = hoursGrid.querySelectorAll('.edit-hour-block').length + 1;
      const block = document.createElement('div');
      block.className = 'edit-hour-block';
      block.innerHTML =
        '<label class="edit-hour-field"><span class="hint">Label</span>' +
        `<input type="text" class="edit-hour-title-input" name="labels" value="Hour ${position}" maxlength="20" /></label>` +
        '<div class="edit-hour-time-row">' +
        '<label class="edit-hour-field"><span class="hint">Start Time</span><input type="text" name="startTimes" placeholder="9:00 AM" /></label>' +
        '<label class="edit-hour-field"><span class="hint">End Time</span><input type="text" name="endTimes" placeholder="9:45 AM" /></label>' +
        '</div>';
      hoursGrid.appendChild(block);
      block.querySelector('input').focus();
    });
  }
});
