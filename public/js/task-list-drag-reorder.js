// Drag-and-drop reordering for the Setup/Cleanup Task List tab (a real
// request: "be able to rearrange the setup/cleanup task list on desktop
// and mobile. drag and move.") - two independent drag scopes on the same
// page: whole list/section cards within .task-list-stack, and individual
// task rows within one section's own tbody. Doesn't replace the existing
// up/down move buttons (routes/admin-setup.js's own /move routes) - both
// stay available side by side, same as public/js/room-row-reorder.js's
// own precedent for the Class Schedule grid's room rows, which this
// mirrors closely: Pointer Events (not mousedown/mousemove/mouseup) so a
// touch drag on mobile works the same as a mouse drag on desktop, and
// only the final on-screen order is ever sent (one fetch per drag, not a
// full form submit/page reload).
(function () {
  if (window.__taskListDragReorderInstalled) return;
  window.__taskListDragReorderInstalled = true;

  let dragging = null; // { kind: 'section'|'item', el, container }

  function sectionCardsIn(stack) {
    return Array.from(stack.querySelectorAll(':scope > [data-task-list-section]'));
  }
  function itemRowsIn(tbody) {
    return Array.from(tbody.querySelectorAll('tr[data-task-list-item]'));
  }

  // The sibling a dragged element at pointer `y` should be dropped in
  // front of, or null to drop at the very end - same midpoint test
  // room-row-reorder.js uses.
  function siblingAtY(siblings, y) {
    for (const el of siblings) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return el;
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    const sectionHandle = e.target.closest('[data-task-list-section-drag-handle]');
    const itemHandle = e.target.closest('[data-task-list-item-drag-handle]');
    if (!sectionHandle && !itemHandle) return;

    if (sectionHandle) {
      const card = sectionHandle.closest('[data-task-list-section]');
      const stack = sectionHandle.closest('[data-task-list-day]');
      if (!card || !stack) return;
      e.preventDefault();
      dragging = { kind: 'section', el: card, container: stack };
      sectionHandle.setPointerCapture(e.pointerId);
      card.classList.add('task-list-card-dragging');
      return;
    }

    const row = itemHandle.closest('tr[data-task-list-item]');
    const tbody = itemHandle.closest('[data-task-list-item-tbody]');
    if (!row || !tbody) return;
    e.preventDefault();
    dragging = { kind: 'item', el: row, container: tbody };
    itemHandle.setPointerCapture(e.pointerId);
    row.classList.add('task-list-item-dragging');
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (dragging.kind === 'section') {
      const siblings = sectionCardsIn(dragging.container).filter((el) => el !== dragging.el);
      const target = siblingAtY(siblings, e.clientY);
      if (target) dragging.container.insertBefore(dragging.el, target);
      else dragging.container.appendChild(dragging.el);
    } else {
      const siblings = itemRowsIn(dragging.container).filter((el) => el !== dragging.el);
      const target = siblingAtY(siblings, e.clientY);
      if (target) dragging.container.insertBefore(dragging.el, target);
      else dragging.container.appendChild(dragging.el);
    }
  });

  document.addEventListener('pointerup', async () => {
    if (!dragging) return;
    const { kind, el, container } = dragging;
    dragging = null;

    if (kind === 'section') {
      el.classList.remove('task-list-card-dragging');
      const day = container.getAttribute('data-task-list-day');
      const sectionIds = sectionCardsIn(container).map((c) => c.getAttribute('data-task-list-section'));
      try {
        await fetch(`/admin/setup/${day}/tasks/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ sectionIds }),
        });
      } catch (err) {
        // Reordering is a nice-to-have, not page-breaking - see
        // room-row-reorder.js's own comment on this same tradeoff.
      }
    } else {
      el.classList.remove('task-list-item-dragging');
      const sectionId = container.getAttribute('data-task-list-section');
      const rows = itemRowsIn(container);
      const itemIds = rows.map((r) => r.getAttribute('data-task-list-item'));
      // The # column reflects each item's saved position (server-
      // computed in utils/taskList.js's itemsForSection) - renumber it
      // immediately so the drag's own result is visible right away,
      // rather than only after the next full page load.
      rows.forEach((r, i) => {
        const numCell = r.querySelector('.task-list-num-col');
        if (numCell) numCell.textContent = String(i + 1);
      });
      try {
        const day = document.querySelector('[data-task-list-day]').getAttribute('data-task-list-day');
        await fetch(`/admin/setup/${day}/tasks/${sectionId}/items/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ itemIds }),
        });
      } catch (err) {
        // Same tradeoff as above.
      }
    }
  });
})();
