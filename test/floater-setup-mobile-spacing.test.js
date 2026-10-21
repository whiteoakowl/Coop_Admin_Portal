// Regression guard for real bug reports/requests, all CSS in public/css/
// styles.css. Can't drive a real browser here (no Playwright devDependency
// - see printCss.test.js's own note on why), but can at least keep the
// specific fixes from quietly regressing back.
//
// 1. "Floater assignment page, each line for a floater everything on the
//    left is touching the border - there should be some space to balance
//    between features and edges, mobile." .floater-chart-table tr
//    switched to a flex row (stacking each slot's Position/Room/Floater
//    onto its own card-width line) but copied only the table row's
//    vertical padding, leaving content flush against the card's edges.
//
// 2. "Setup/cleanup team assignments... the dropdown choices for picking
//    a task. You can't see anything in the dropdown. You should at least
//    be able to see the task number. Shrink everything on each row to
//    make a bit more space for everything, mobile." .setup-assignment-
//    table was originally fixed mobile-only, stacking it the same way
//    Floater's own chart already was - a later real request ("just line
//    the assignments under each member like mobile") made that stacking
//    unconditional instead, so the table never goes back to being a real
//    multi-column layout at any width.
//
// 3. That same unconditional stacking hit its own specificity trap live:
//    .floater-card-table's own base 40%/24%/36% column-width rule (the
//    shared class .setup-assignment-table rides along with, for Floater
//    Assignments' unrelated Position/Room/Floater columns) outranks a
//    plain `.setup-assignment-table td { width: 100% }` reset on
//    specificity alone (an extra :nth-child pseudo-class), so the fix
//    needs its own matching :nth-child(N) override or each cell stays
//    stuck at Floater's own fraction of the row despite the table
//    "stacking."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rawCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

test('.floater-chart-table tr has real horizontal padding on mobile, not just vertical', () => {
  const match = /\.floater-chart-table\s+tr\s*\{([^}]*)\}/.exec(css);
  assert.ok(match, 'expected a .floater-chart-table tr rule');
  const decl = /padding:\s*([^;]+);/.exec(match[1]);
  assert.ok(decl, 'expected a padding declaration on .floater-chart-table tr');
  const parts = decl[1].trim().split(/\s+/);
  // Shorthand padding: 1 value = all sides, 2 values = vertical horizontal,
  // 4 values = top right bottom left. Only the "vertical-only, 0
  // horizontal" shape (exactly 2 values, second one 0) is the bug.
  assert.ok(!(parts.length === 2 && /^0(px|rem|em|%)?$/.test(parts[1])), `padding "${decl[1].trim()}" still has no horizontal inset`);
});

test('.setup-assignment-table stacks to full-width rows unconditionally, not just on mobile', () => {
  // No `@media` wrapper around this - a real request ("just line the
  // assignments under each member like mobile") made this layout the
  // table's permanent shape, not a narrow-viewport-only fallback.
  assert.match(css, /\.setup-assignment-table,\s*\.setup-assignment-table tbody\s*\{\s*display:\s*block;/, 'the table must always stack, the same fix already applied to .floater-chart-table on mobile');
  assert.match(css, /\.setup-assignment-table thead\s*\{\s*display:\s*none;\s*\}/, 'the header row should stay hidden at every width now');
  assert.match(css, /\.setup-assignment-table tr\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;/, 'each row must stack Member/Task 1/Task 2/Task 3 as a flex column');
});

test('.setup-assignment-table td width is reset to 100% for all 4 columns, overriding .floater-card-table\'s own 40%/24%/36% split', () => {
  // The shared-class base rule (Floater Assignments' own Position/Room/
  // Floater columns) that this has to outrank, specificity-for-specificity.
  assert.match(css, /\.floater-card-table th:nth-child\(1\), \.floater-card-table td:nth-child\(1\) \{ width: 40%; \}/, "expected the base .floater-card-table column-width rule this test's own fix has to outrank");

  // Must match the SAME selector shape (.setup-assignment-table
  // td:nth-child(N)) as the base rule above - a lower-specificity plain
  // `.setup-assignment-table td { width: 100% }` loses to it and silently
  // does nothing, which is exactly what shipped broken (live-confirmed:
  // the first three cells measured 40%/24%/36% of the row instead of 100%).
  [1, 2, 3, 4].forEach((n) => {
    assert.match(css, new RegExp(`\\.setup-assignment-table td:nth-child\\(${n}\\)[^{]*\\{[^}]*width:\\s*100%`), `expected .setup-assignment-table td:nth-child(${n}) to reset width: 100%`);
  });
});

// A real request: "floater assignments you can't see the names in the
// dropdown its so tiny now." The Text Notification column added later
// (test/routes-admin-volunteers-floater-text-notify.test.js) left the
// old 2-up grid's fixed 1050px breakpoint too tight for the Floater
// select at some real window widths just above it (live-measured: ~105px
// wide at 1060px, still only ~157px at 1350px) - replaced with a self-
// adjusting auto-fit/minmax grid instead of hand-tuning a new pixel
// number for a table shape that keeps changing.
test('.floater-chart-cards-grid uses auto-fit/minmax instead of a fixed-breakpoint 2-column grid', () => {
  assert.match(
    css,
    /\.floater-chart-cards-grid\s*\{\s*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(480px,\s*100%\),\s*1fr\)\);\s*\}/,
    'expected an auto-fit/minmax grid (never fewer than 480px per card, falling back below the viewport width on a narrow phone) instead of a fixed max-width breakpoint'
  );
  assert.doesNotMatch(css, /@media \(max-width: 1050px\) \{\s*\.floater-chart-cards-grid/, 'the old fixed 1050px breakpoint override should be gone, not left alongside the new rule');
});

// A real follow-up: the grid fix above wasn't the whole bug - the phone-
// width stacked layout (@media max-width: 640px) has its OWN separate
// nth-child(2)/(3) rules that shifted out of alignment the same way,
// live-reproduced on an actual phone: the Floater select never got
// flex: 1 1 100% (a different cell, Room, got it instead), so it fell
// back to shrink-to-fit sizing instead of the row's full width.
test('.floater-chart-table td:nth-child(3)/(4) (not (2)/(3)) get the mobile "· Room" prefix and the Floater column\'s full-row-width flex', () => {
  assert.match(css, /\.floater-chart-table td:nth-child\(3\) \{ color: var\(--muted\); \}/, 'expected the "· " separator\'s color rule to target Room at its real nth-child position (3), not (2)');
  assert.match(css, /\.floater-chart-table td:nth-child\(3\)::before \{ content: "\\00b7\\0020"; \}/, 'expected the "· " separator itself to target Room at (3), not (2)');
  assert.match(css, /\.floater-chart-table td:nth-child\(4\) \{ flex: 1 1 100%; min-width: 0; \}/, "expected the Floater column's full-row-width flex to target its real nth-child position (4), not (3)");
});
