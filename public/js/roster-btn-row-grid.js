// Mobile-only (see public/css/styles.css's matching @media max-width:
// 640px block): every .roster-btn-row toolbar (Attendance, Schedules,
// Setup/Cleanup, Floater Assignments, ...) should lay its buttons out in
// exactly 2 rows, each button filling its row's full width evenly - not
// a horizontally-scrolling single row (the original bug report) and not
// a fixed 2-per-row grid, which spills to 3+ rows once a toolbar has more
// than 4 buttons.
//
// Pure CSS can't express "however many buttons there are, split into
// exactly 2 rows" without knowing the count - grid-template-columns:
// repeat(2, 1fr) always means 2 COLUMNS (any number of rows), while
// getting exactly 2 ROWS with an unknown item count needs grid-auto-flow:
// column, which lays items out top-to-bottom THEN left-to-right (button 1
// under button 2, button 3 under button 4, ...) - the visual reading
// order across the two rows no longer matches the toolbar's actual
// left-to-right button order. So this sets grid-template-columns
// directly, computed from the real button count, keeping the default
// row-major grid-auto-flow (left-to-right, top row first) intact.
(function () {
  function layout(row) {
    // A toolbar action that's really a tiny <form method="POST"> around
    // its own .roster-action-btn (Resync, Archive, ...) counts as one
    // "slot" too, same as a plain <button> - styles.css makes that form
    // display: contents on mobile so its button IS the real grid item,
    // so this counts the button, not the (layout-invisible) form itself.
    const items = row.querySelectorAll(':scope > .roster-action-btn, :scope > form > .roster-action-btn');
    if (items.length === 0) return;
    const columns = Math.ceil(items.length / 2);
    row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  }

  function layoutAll() {
    if (!window.matchMedia('(max-width: 640px)').matches) {
      // Clear any inline column count left over from a wider viewport
      // shrinking back down later - the CSS's own base rules take over
      // above the breakpoint.
      document.querySelectorAll('.roster-btn-row').forEach((row) => { row.style.gridTemplateColumns = ''; });
      return;
    }
    document.querySelectorAll('.roster-btn-row').forEach(layout);
  }

  window.addEventListener('load', layoutAll);
  window.addEventListener('resize', layoutAll);
  document.addEventListener('fullscreenchange', () => setTimeout(layoutAll, 50));
})();
