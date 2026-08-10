// Real unit coverage for utils/pagination.js - the shared in-memory
// pagination helper behind the Phase 4 audit item's Members/Logs/Library
// rollout. Pure and dependency-free, so it's cheap to pin down the edge
// cases that matter most: clamping an out-of-range page instead of
// returning an empty slice, and never dividing by zero on an empty list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate, parsePage, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

test('parsePage', async (t) => {
  await t.test('parses a valid positive integer string', () => {
    assert.equal(parsePage('3'), 3);
  });

  await t.test('defaults to 1 for missing, non-numeric, zero, or negative input', () => {
    assert.equal(parsePage(undefined), 1);
    assert.equal(parsePage(''), 1);
    assert.equal(parsePage('abc'), 1);
    assert.equal(parsePage('0'), 1);
    assert.equal(parsePage('-5'), 1);
  });

  await t.test('truncates a fractional string to its integer part', () => {
    assert.equal(parsePage('2.9'), 2);
  });
});

test('paginate', async (t) => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);

  await t.test('returns the requested page sliced to pageSize', () => {
    const page = paginate(items, 1, 10);
    assert.deepEqual(page.items, items.slice(0, 10));
    assert.equal(page.currentPage, 1);
    assert.equal(page.totalPages, 3);
    assert.equal(page.totalItems, 25);
    assert.equal(page.hasPrev, false);
    assert.equal(page.hasNext, true);
    assert.equal(page.startIndex, 1);
    assert.equal(page.endIndex, 10);
  });

  await t.test('the last page holds only the remainder, not a full pageSize', () => {
    const page = paginate(items, 3, 10);
    assert.deepEqual(page.items, items.slice(20, 25));
    assert.equal(page.items.length, 5);
    assert.equal(page.hasNext, false);
    assert.equal(page.hasPrev, true);
    assert.equal(page.startIndex, 21);
    assert.equal(page.endIndex, 25);
  });

  await t.test('a page past the end clamps to the last real page instead of returning empty', () => {
    const page = paginate(items, 999, 10);
    assert.equal(page.currentPage, 3);
    assert.deepEqual(page.items, items.slice(20, 25));
  });

  await t.test('a page below 1 clamps to page 1', () => {
    const page = paginate(items, -3, 10);
    assert.equal(page.currentPage, 1);
  });

  await t.test('an empty list is one empty page, not a division-by-zero crash', () => {
    const page = paginate([], 1, 10);
    assert.equal(page.totalPages, 1);
    assert.equal(page.currentPage, 1);
    assert.deepEqual(page.items, []);
    assert.equal(page.hasPrev, false);
    assert.equal(page.hasNext, false);
    assert.equal(page.startIndex, 0);
    assert.equal(page.endIndex, 0);
  });

  await t.test('a list that exactly fills one page has no next page', () => {
    const page = paginate(items.slice(0, 10), 1, 10);
    assert.equal(page.totalPages, 1);
    assert.equal(page.hasNext, false);
  });

  await t.test('defaults to DEFAULT_PAGE_SIZE when no pageSize is given', () => {
    const bigList = Array.from({ length: DEFAULT_PAGE_SIZE + 5 }, (_, i) => i);
    const page = paginate(bigList, 1);
    assert.equal(page.items.length, DEFAULT_PAGE_SIZE);
    assert.equal(page.totalPages, 2);
  });
});
