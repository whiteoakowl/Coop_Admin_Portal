// Pure-function coverage for utils/events.js's monthGrid() - a real bug
// report: "when viewing a month on the calendar it shouldn't show the
// dates for the next month at the bottom." The grid always built a fixed
// 6 rows so every month lines up to the same height, but a month that
// only needs 5 (or even 4) calendar rows to show every one of its own
// days ended up with a trailing row that was entirely next month's
// leading days (inMonth: false) - monthGrid now drops any such row(s)
// off the end instead of rendering them.
const path = require('path');
const os = require('os');
process.env.DB_PATH = path.join(os.tmpdir(), `utils-events-month-grid-test-db-${process.pid}.db`);
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `utils-events-month-grid-test-uploads-${process.pid}`);
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const test = require('node:test');
const assert = require('node:assert/strict');
const { monthGrid } = require('../utils/events');

test('monthGrid never renders a trailing row that is entirely next month', () => {
  // October 2026 starts on a Thursday and has 31 days - its own calendar
  // grid only needs 5 rows (Sun 9/27 through Sat 10/31); a 6th fixed row
  // would have been 10/1-10/3 (next month) through 11/4-11/7, every cell
  // inMonth: false.
  const october = monthGrid('2026-10', []);
  assert.equal(october.weeks.length, 5, 'October 2026 should render exactly 5 rows, not a 6th all-next-month row');
  assert.ok(october.weeks[october.weeks.length - 1].some((d) => d.inMonth), 'the last row rendered must contain at least one real October day');

  // February 2026 starts on a Sunday and has 28 days - exactly 4 calendar
  // rows, the tightest possible case, to confirm this trims as many
  // trailing all-next-month rows as actually needed, not just one.
  const february = monthGrid('2026-02', []);
  assert.equal(february.weeks.length, 4, 'February 2026 (starts on Sunday, 28 days) should render exactly 4 rows');

  // A month whose grid genuinely needs the full 6 rows (starts late in
  // the week and runs long) must still get all 6 - this is a trim of
  // genuinely empty trailing rows only, never a hardcoded cap.
  const may = monthGrid('2026-05', []);
  assert.equal(may.weeks.length, 6, 'May 2026 (starts on Friday, 31 days) genuinely needs all 6 rows');
});
