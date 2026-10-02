// Regression guard for two real bug reports, both mobile-only CSS in
// public/css/styles.css. Can't drive a real browser here (no Playwright
// devDependency - see printCss.test.js's own note on why), but can at
// least keep the specific fixes from quietly regressing back.
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
//    table stayed a real 3-column table on a phone, squeezing each task
//    dropdown into roughly a third of the card's width - fixed by
//    stacking it the same way Floater's own chart already was, but an
//    earlier desktop-width :nth-child(N) column-width rule outranks a
//    plain `.setup-assignment-table td` reset on specificity alone, so
//    the fix needs its own matching :nth-child(N) override or the
//    dropdown stays stuck at its old, illegibly narrow fraction of the
//    row despite the table "stacking."
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

test('.setup-assignment-table stacks to full-width rows on mobile (not a cramped 3-column table)', () => {
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.setup-assignment-table,\s*\.setup-assignment-table tbody\s*\{\s*display:\s*block;/, 'the table must switch to block/flex stacking on mobile, the same fix already applied to .floater-chart-table');
});

test('.setup-assignment-table td width is reset for all 3 columns on mobile, overriding the desktop :nth-child split', () => {
  // The desktop-width rule (outside any media query) that this has to
  // outrank, specificity-for-specificity.
  assert.match(css, /\.setup-assignment-table th:nth-child\(1\), \.setup-assignment-table td:nth-child\(1\) \{ width: 36%; \}/, "expected the desktop column-width rule this test's own fix has to outrank");

  const mobileBlockMatch = /@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/.exec(css.slice(css.indexOf('@media (max-width: 640px)')));
  assert.ok(mobileBlockMatch, 'expected to find the mobile media query block');
  const mobileBlock = mobileBlockMatch[1];
  // Must match the SAME selector shape (.setup-assignment-table
  // td:nth-child(N)) as the desktop rule above - a lower-specificity
  // plain `.setup-assignment-table td { width: auto }` loses to it and
  // silently does nothing, which is exactly what shipped broken.
  [1, 2, 3].forEach((n) => {
    assert.match(mobileBlock, new RegExp(`\\.setup-assignment-table td:nth-child\\(${n}\\)[^{]*\\{[^}]*width:\\s*auto`), `expected .setup-assignment-table td:nth-child(${n}) to reset width: auto inside the mobile media query`);
  });
});
