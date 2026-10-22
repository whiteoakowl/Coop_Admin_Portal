// Drag-and-drop for the Parent Portal Weekly Planner grid (views/parent-
// family-school-weekly-planner.ejs) - a real request: "allow to drag and
// drop lessons and assignments between days." Same native Pointer
// Events shape as public/js/homepage-block-reorder.js (touch works
// identically to mouse, a failed save is a silent no-op) - the one real
// difference is the dragged item can land in a DIFFERENT drop zone
// (another day's column), not just reorder among its own siblings.
(function () {
  if (window.__weeklyPlannerDragDropInstalled) return;
  window.__weeklyPlannerDragDropInstalled = true;

  let dragging = null; // { li, fromZone }

  function zones() {
    return Array.from(document.querySelectorAll('[data-week-date-id].fs-weekly-plan-dropzone'));
  }

  function listIn(zone) {
    return zone.querySelector('.fs-weekly-plan-assignment-list');
  }

  function itemsIn(zone) {
    const list = listIn(zone);
    return list ? Array.from(list.querySelectorAll(':scope > li')) : [];
  }

  function siblingAtY(siblings, y) {
    for (const el of siblings) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return el;
    }
    return null;
  }

  function zoneAtPoint(x, y) {
    return zones().find((z) => {
      const rect = z.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  }

  function setZoneEmptyState(zone) {
    const list = listIn(zone);
    const hint = zone.querySelector('.fs-weekly-plan-empty-hint');
    const hasItems = list && list.children.length > 0;
    if (list) list.hidden = !hasItems;
    if (hint) hint.hidden = hasItems;
  }

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-assignment-drag-handle]');
    if (!handle) return;
    const li = handle.closest('li[data-assignment-id]');
    const fromZone = handle.closest('.fs-weekly-plan-dropzone');
    if (!li || !fromZone) return;
    e.preventDefault();
    dragging = { li, fromZone };
    handle.setPointerCapture(e.pointerId);
    li.classList.add('fs-weekly-plan-dragging');
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const zone = zoneAtPoint(e.clientX, e.clientY);
    if (!zone) return;
    zones().forEach((z) => z.classList.toggle('fs-weekly-plan-drop-target-hover', z === zone));
    let list = listIn(zone);
    if (!list) return;
    const siblings = itemsIn(zone).filter((el) => el !== dragging.li);
    const target = siblingAtY(siblings, e.clientY);
    if (target) list.insertBefore(dragging.li, target);
    else list.appendChild(dragging.li);
    setZoneEmptyState(zone);
    if (zone !== dragging.fromZone) setZoneEmptyState(dragging.fromZone);
  });

  document.addEventListener('pointerup', async () => {
    if (!dragging) return;
    const { li, fromZone } = dragging;
    dragging = null;
    li.classList.remove('fs-weekly-plan-dragging');
    zones().forEach((z) => z.classList.remove('fs-weekly-plan-drop-target-hover'));

    const currentZone = li.closest('.fs-weekly-plan-dropzone');
    if (!currentZone || currentZone === fromZone) return;
    const weekDateId = currentZone.getAttribute('data-week-date-id');
    const assignmentId = li.getAttribute('data-assignment-id');
    try {
      await fetch(`/parent/family-school/weekly-planner/assignments/${assignmentId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: 'weekDateId=' + encodeURIComponent(weekDateId),
      });
    } catch (err) {
      // Same tradeoff as homepage-block-reorder.js's own comment -
      // moving an assignment is a nice-to-have UI action, not page-
      // breaking if the save silently fails on a flaky connection.
    }
  });
})();
