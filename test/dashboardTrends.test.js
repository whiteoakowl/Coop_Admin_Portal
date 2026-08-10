// Real unit coverage for utils/dashboardTrends.js - the comparison logic
// behind the Home dashboard's "Today's Attendance" trend indicators
// (Phase 4 audit item). Pure and dependency-free, so worth pinning down
// the edge case that matters most: no previous session to compare
// against (a brand-new co-op's very first session day) must render
// nothing, not a misleading "0 -> N, up" comparison against a session
// that never happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTrend } = require('../utils/dashboardTrends');

test('computeTrend', async (t) => {
  await t.test('returns null when there is no previous session to compare against', () => {
    assert.equal(computeTrend(5, null), null);
    assert.equal(computeTrend(5, undefined), null);
  });

  await t.test('an increase is "up" with a positive delta', () => {
    assert.deepEqual(computeTrend(8, 5), { direction: 'up', delta: 3 });
  });

  await t.test('a decrease is "down" with a negative delta', () => {
    assert.deepEqual(computeTrend(2, 5), { direction: 'down', delta: -3 });
  });

  await t.test('no change is "flat" with a zero delta', () => {
    assert.deepEqual(computeTrend(5, 5), { direction: 'flat', delta: 0 });
  });

  await t.test('a previous value of zero is a real comparison, not treated as "no previous session"', () => {
    assert.deepEqual(computeTrend(3, 0), { direction: 'up', delta: 3 });
  });

  await t.test('both values at zero is flat, not null', () => {
    assert.deepEqual(computeTrend(0, 0), { direction: 'flat', delta: 0 });
  });
});
