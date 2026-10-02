// Task List tab (Setup/Cleanup): a real request - "no edit button" on
// each list, "should be able to click edit button on each list and
// change the information. Check mark is then at the top of the list
// card to save." Each card starts view-only; clicking its own Edit
// button unlocks just that card's title/task inputs and reveals its own
// drag handles/delete controls, same card-scoped data-task-list-edit-only
// gate task-list-drag-reorder.js's handles already use - a checkmark
// button then takes Edit's place to save just this one card, posting
// only ITS OWN sectionTitle_/sectionTeam_/itemDesc_ fields to the
// existing /tasks/save route (routes/admin-setup.js), which already only
// touches whatever keys it's handed - no change needed there for this to
// become per-card instead of a single page-wide Edit/Save.
(function () {
  if (window.__taskListCardEditInstalled) return;
  window.__taskListCardEditInstalled = true;

  const stack = document.querySelector('[data-task-list-form]');
  if (!stack) return;
  const day = stack.getAttribute('data-task-list-day');
  const semesterId = document.getElementById('main-content')?.dataset.semesterId || '';

  function setEditing(card, editing) {
    card.querySelectorAll('[data-task-list-input]').forEach((el) => { el.readOnly = !editing; });
    card.querySelectorAll('[data-task-list-edit-only]').forEach((el) => { el.hidden = !editing; });
    const badge = card.querySelector('.task-list-team-badge');
    if (badge) badge.hidden = editing;
    const editBtn = card.querySelector('[data-task-list-edit-btn]');
    const saveBtn = card.querySelector('[data-task-list-save-btn]');
    if (editBtn) editBtn.hidden = editing;
    if (saveBtn) saveBtn.hidden = !editing;
  }

  stack.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-task-list-edit-btn]');
    if (editBtn) {
      setEditing(editBtn.closest('[data-task-list-section]'), true);
      return;
    }

    const saveBtn = e.target.closest('[data-task-list-save-btn]');
    if (!saveBtn) return;
    const card = saveBtn.closest('[data-task-list-section]');
    const sectionId = card.getAttribute('data-task-list-section');
    saveBtn.disabled = true;

    const params = new URLSearchParams();
    const titleInput = card.querySelector(`[name="sectionTitle_${sectionId}"]`);
    if (titleInput) params.set(titleInput.name, titleInput.value);
    const teamSelect = card.querySelector(`[name="sectionTeam_${sectionId}"]`);
    if (teamSelect) params.set(teamSelect.name, teamSelect.value);
    card.querySelectorAll('[name^="itemDesc_"]').forEach((input) => { params.set(input.name, input.value); });

    try {
      const res = await fetch(`/admin/setup/${day}/tasks/save?semesterId=${encodeURIComponent(semesterId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'fetch',
          'X-CSRF-Token': window.CSRF_TOKEN || '',
        },
        body: params.toString(),
      });
      if (!res.ok) throw new Error('save failed');
      setEditing(card, false);
      // Reflect the just-saved team link in the read-only badge without a
      // full reload - mirrors routes/admin-setup.js's own "Linked to
      // team: X" line, omitted entirely once unlinked. Runs after
      // setEditing (which unhides the badge for view mode) so an unlink
      // can re-hide it instead of showing an empty line.
      let badge = card.querySelector('.task-list-team-badge');
      if (teamSelect) {
        if (teamSelect.value) {
          const label = teamSelect.selectedOptions[0] ? teamSelect.selectedOptions[0].textContent : '';
          if (!badge) {
            badge = document.createElement('p');
            badge.className = 'task-list-team-badge hint no-edit-hide';
            card.querySelector('.task-list-team-row').insertAdjacentElement('afterend', badge);
          }
          badge.textContent = `Linked to team: ${label}`;
          badge.hidden = false;
        } else if (badge) {
          badge.hidden = true;
        }
      }
    } catch (err) {
      window.alert('Could not save - please try again.');
      saveBtn.disabled = false;
    }
  });
})();
