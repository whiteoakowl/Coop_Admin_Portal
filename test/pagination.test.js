// Real unit coverage for utils/pagination.js - the shared in-memory
// pagination helper behind the Phase 4 audit item's Members/Logs/Library
// rollout. Pure and dependency-free, so it's cheap to pin down the edge
// cases that matter most: clamping an out-of-range page instead of
// returning an empty slice, and never dividing by zero on an empty list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE, memberFamilyGroupKey } = require('../utils/pagination');

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

  // A real request: "a view all button." pageSize=Infinity (what
  // parsePageSize below resolves ?pageSize=all to) needs no special-
  // casing here - the math already degrades correctly on its own.
  await t.test('pageSize=Infinity returns every item as a single page', () => {
    const page = paginate(items, 1, Infinity);
    assert.deepEqual(page.items, items);
    assert.equal(page.totalPages, 1);
    assert.equal(page.currentPage, 1);
    assert.equal(page.hasPrev, false);
    assert.equal(page.hasNext, false);
    assert.equal(page.startIndex, 1);
    assert.equal(page.endIndex, 25);
  });
});

// A real bug report (Members list, Main Admin and Co-op Admin alike):
// "the dropdown for the last family on the page is sometimes putting
// part of the family on the next page. Families should stay together...
// each member list page doesn't have to be an exact number of members."
test('paginate with a groupKeyFn keeps a split-spanning group together', async (t) => {
  // 3 solo items, then a 4-member family, then 2 more solo items - a
  // pageSize of 4 would otherwise cut the family after its first 2
  // members (indices 3-4 of 0-9).
  const items = [
    { name: 'solo-1', family_id: null, id: 1 },
    { name: 'solo-2', family_id: null, id: 2 },
    { name: 'solo-3', family_id: null, id: 3 },
    { name: 'family-a-1', family_id: 100, id: 4 },
    { name: 'family-a-2', family_id: 100, id: 5 },
    { name: 'family-a-3', family_id: 100, id: 6 },
    { name: 'family-a-4', family_id: 100, id: 7 },
    { name: 'solo-4', family_id: null, id: 8 },
    { name: 'solo-5', family_id: null, id: 9 },
  ];

  await t.test('page 1 grows past pageSize to include the whole family rather than splitting it', () => {
    const page = paginate(items, 1, 4, memberFamilyGroupKey);
    assert.equal(page.items.length, 7, 'grew from 4 to 7 to keep all 4 family-a members together');
    assert.deepEqual(page.items.map((m) => m.name), ['solo-1', 'solo-2', 'solo-3', 'family-a-1', 'family-a-2', 'family-a-3', 'family-a-4']);
    assert.equal(page.hasNext, true);
  });

  await t.test('page 2 starts right after where page 1 actually ended, not at the naive arithmetic offset', () => {
    const page = paginate(items, 2, 4, memberFamilyGroupKey);
    assert.deepEqual(page.items.map((m) => m.name), ['solo-4', 'solo-5']);
    assert.equal(page.hasNext, false);
    assert.equal(page.hasPrev, true);
  });

  await t.test('totalPages reflects the real (grouping-adjusted) number of pages, not items.length / pageSize', () => {
    const page = paginate(items, 1, 4, memberFamilyGroupKey);
    assert.equal(page.totalPages, 2);
  });

  await t.test('two solo members (no family_id) are never grouped with each other just for both being null', () => {
    const soloOnly = [
      { name: 'solo-1', family_id: null, id: 1 },
      { name: 'solo-2', family_id: null, id: 2 },
      { name: 'solo-3', family_id: null, id: 3 },
    ];
    const page = paginate(soloOnly, 1, 2, memberFamilyGroupKey);
    assert.equal(page.items.length, 2, 'ordinary pageSize split between two unrelated solo members is fine');
    assert.equal(page.totalPages, 2);
  });

  await t.test('a group exactly at the pageSize boundary needs no extension', () => {
    const exact = [
      { name: 'solo-1', family_id: null, id: 1 },
      { name: 'solo-2', family_id: null, id: 2 },
      { name: 'solo-3', family_id: null, id: 3 },
      { name: 'solo-4', family_id: null, id: 4 },
    ];
    const page = paginate(exact, 1, 4, memberFamilyGroupKey);
    assert.equal(page.items.length, 4);
    assert.equal(page.totalPages, 1);
  });

  await t.test('pageSize=Infinity (View All) with a groupKeyFn still returns everything as one page', () => {
    const page = paginate(items, 1, Infinity, memberFamilyGroupKey);
    assert.equal(page.items.length, items.length);
    assert.equal(page.totalPages, 1);
  });

  await t.test('an empty list with a groupKeyFn is one empty page, not a crash', () => {
    const page = paginate([], 1, 10, memberFamilyGroupKey);
    assert.deepEqual(page.items, []);
    assert.equal(page.totalPages, 1);
  });

  await t.test('without a groupKeyFn, behavior is unchanged - a family can still split (every other paginate() caller)', () => {
    const page = paginate(items, 1, 4);
    assert.equal(page.items.length, 4, 'no grouping requested, so the plain fixed-size slice applies');
  });
});

test('parsePageSize', async (t) => {
  await t.test('resolves the literal "all" to Infinity', () => {
    assert.equal(parsePageSize('all', DEFAULT_PAGE_SIZE), Infinity);
  });

  await t.test('falls back to the given default for anything else - missing, garbage, or a spoofed number', () => {
    assert.equal(parsePageSize(undefined, DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
    assert.equal(parsePageSize('', DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
    assert.equal(parsePageSize('200', DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
    assert.equal(parsePageSize('Infinity', DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
  });
});
