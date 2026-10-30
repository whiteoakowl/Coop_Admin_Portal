// Drag-and-drop reordering for the Public Homepage builder's own block
// canvas (views/main-admin-website.ejs) - a real request: "drag and drop
// images and text." Same native Pointer Events shape as public/js/
// lesson-drag-reorder.js (touch works identically to mouse, only the
// final on-screen order is ever sent, a failed save is a silent no-op),
// just over plain <div> blocks in a container instead of <tr> rows in a
// <tbody> - the builder's own blocks aren't a table.
(function () {
  if (window.__homepageBlockReorderInstalled) return;
  window.__homepageBlockReorderInstalled = true;

  let dragging = null; // { row, container }

  function rowsIn(container) {
    return Array.from(container.querySelectorAll(':scope > [data-homepage-block-row]'));
  }

  function siblingAtY(siblings, y) {
    for (const el of siblings) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return el;
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-homepage-block-drag-handle]');
    if (!handle) return;
    const row = handle.closest('[data-homepage-block-row]');
    const container = handle.closest('[data-homepage-blocks-container]');
    if (!row || !container) return;
    e.preventDefault();
    dragging = { row, container };
    handle.setPointerCapture(e.pointerId);
    row.classList.add('homepage-builder-block-dragging');
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const siblings = rowsIn(dragging.container).filter((el) => el !== dragging.row);
    const target = siblingAtY(siblings, e.clientY);
    if (target) dragging.container.insertBefore(dragging.row, target);
    else dragging.container.appendChild(dragging.row);
  });

  document.addEventListener('pointerup', async () => {
    if (!dragging) return;
    const { row, container } = dragging;
    dragging = null;
    row.classList.remove('homepage-builder-block-dragging');

    const reorderUrl = container.getAttribute('data-reorder-url');
    const blockIds = rowsIn(container).map((r) => r.getAttribute('data-homepage-block-row'));
    // Custom Forms' own fields-within-a-page canvas (views/admin-custom-
    // forms-builder.ejs) is the first caller that needs more than just
    // the final order sent back - its reorder route also needs to know
    // WHICH page these fields belong to, so a stale/tampered id can't
    // move a field into a different page's own position sequence.
    // data-reorder-extra is optional JSON merged into the request body
    // alongside blockIds - every existing caller (Public Homepage's own
    // blocks/menu-items) has no such attribute, so this changes nothing
    // for them.
    let extra = {};
    const extraRaw = container.getAttribute('data-reorder-extra');
    if (extraRaw) {
      try {
        extra = JSON.parse(extraRaw);
      } catch (err) {
        extra = {};
      }
    }
    try {
      await fetch(reorderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: JSON.stringify({ blockIds, ...extra }),
      });
    } catch (err) {
      // Same tradeoff as lesson-drag-reorder.js's own comment - reordering
      // is a nice-to-have, not page-breaking.
    }
  });
})();
