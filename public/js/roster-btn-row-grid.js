// Mobile-only (see public/css/styles.css's matching @media max-width:
// 640px block): every .roster-btn-row toolbar (Attendance, Schedules,
// Setup/Cleanup, Floater Assignments, ...) should lay its buttons out
// balanced across as few rows as it takes to keep every row at 4 columns
// or fewer, each button filling its row's full width evenly - not a
// horizontally-scrolling single row (the original bug report), not a
// fixed 2-per-row grid (spills to 3+ rows once a toolbar has more than 4
// buttons), and not a fixed "always exactly 2 rows" grid either - a real
// bug report, once a toolbar grew past 8 buttons (Members page's own
// grew to 9 after combining Add/Edit Families into one button): "no more
// than 4 buttons on a row" - splitting into just 2 rows put 5 across one
// of them.
//
// Pure CSS can't express "however many buttons there are, spread them
// across the fewest rows that keep every row at 4 columns or fewer"
// without knowing the count - grid-template-columns: repeat(4, 1fr)
// alone would always mean exactly 4 columns even for a short 2-button
// toolbar (2 empty-looking gaps), and grid-auto-flow: column (the only
// way to get a fixed ROW count purely in CSS) lays items out top-to-
// bottom THEN left-to-right (button 1 under button 2, button 3 under
// button 4, ...) - the visual reading order no longer matches the
// toolbar's actual left-to-right button order. So this sets grid-
// template-columns directly, computed from the real button count, keeping
// the default row-major grid-auto-flow (left-to-right, top row first)
// intact.
(function () {
  function layout(row) {
    // A toolbar action that's really a tiny <form method="POST"> around
    // its own .roster-action-btn (Resync, Archive, ...) counts as one
    // "slot" too, same as a plain <button> - styles.css makes that form
    // display: contents on mobile so its button IS the real grid item,
    // so this counts the button, not the (layout-invisible) form itself.
    const items = row.querySelectorAll(':scope > .roster-action-btn, :scope > form > .roster-action-btn');
    if (items.length === 0) return;
    // As few rows as it takes to keep every row at 4 columns or fewer,
    // then columns balanced evenly across exactly that many rows (rather
    // than cramming 4-per-row into every row but the last, which would
    // leave one short, lopsided trailing row instead of an even grid).
    const MAX_COLUMNS = 4;
    const rows = Math.ceil(items.length / MAX_COLUMNS);
    const columns = Math.ceil(items.length / rows);
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
