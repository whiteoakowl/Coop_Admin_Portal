// Drag-and-drop reordering for Lessons (within a class) and Lesson
// Content items (within one lesson) - a real request: "be able to
// reorder, assignments or lessons, drag and drop." Same native Pointer
// Events shape as public/js/task-list-drag-reorder.js and
// public/js/room-row-reorder.js: touch works identically to mouse, only
// the final on-screen order is ever sent, and a failed save is a silent
// no-op (reordering is a nice-to-have, not page-breaking). Shared by both
// Co-op Admin and Teacher Portal - each page supplies its own reorder URL
// via a data attribute rather than this file hardcoding /admin/ or
// /teacher/.
(function () {
  if (window.__lessonDragReorderInstalled) return;
  window.__lessonDragReorderInstalled = true;

  let dragging = null; // { row, tbody }

  function rowsIn(tbody) {
    return Array.from(tbody.querySelectorAll(':scope > tr[data-lesson-reorder-row], :scope > tr[data-content-reorder-row]'));
  }

  function siblingAtY(siblings, y) {
    for (const el of siblings) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return el;
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-lesson-reorder-handle], [data-content-reorder-handle]');
    if (!handle) return;
    const row = handle.closest('tr[data-lesson-reorder-row], tr[data-content-reorder-row]');
    const tbody = handle.closest('[data-lesson-reorder-tbody], [data-content-reorder-tbody]');
    if (!row || !tbody) return;
    e.preventDefault();
    dragging = { row, tbody };
    handle.setPointerCapture(e.pointerId);
    row.classList.add('lesson-row-dragging');
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const siblings = rowsIn(dragging.tbody).filter((el) => el !== dragging.row);
    const target = siblingAtY(siblings, e.clientY);
    if (target) dragging.tbody.insertBefore(dragging.row, target);
    else dragging.tbody.appendChild(dragging.row);
  });

  document.addEventListener('pointerup', async () => {
    if (!dragging) return;
    const { row, tbody } = dragging;
    dragging = null;
    row.classList.remove('lesson-row-dragging');

    const isLessonList = tbody.hasAttribute('data-lesson-reorder-tbody');
    try {
      if (isLessonList) {
        const classId = tbody.getAttribute('data-class-id');
        const reorderUrl = tbody.getAttribute('data-reorder-url') || `/admin/class-schedule/classes/${classId}/assignments/reorder`;
        const assignmentIds = rowsIn(tbody).map((r) => r.getAttribute('data-lesson-reorder-row'));
        await fetch(reorderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ assignmentIds }),
        });
      } else {
        const assignmentId = tbody.getAttribute('data-assignment-id');
        const reorderUrl = tbody.getAttribute('data-reorder-url') || `/admin/class-schedule/assignments/${assignmentId}/content/reorder`;
        const contentItemIds = rowsIn(tbody).map((r) => r.getAttribute('data-content-reorder-row'));
        await fetch(reorderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ contentItemIds }),
        });
      }
    } catch (err) {
      // Same tradeoff as task-list-drag-reorder.js's own comment.
    }
  });
})();
