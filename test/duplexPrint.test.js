// Real unit coverage for utils/duplexPrint.js - pure page-chunking logic,
// but the one thing it has to get exactly right (mirroring column order
// per row, with correct blank-padding on a partial last row) is the whole
// reason task #87 exists: get it wrong and every duplex-printed card in
// the app is silently cut apart mismatched, front to the wrong back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDuplexPages, mirrorPage, CARDS_PER_PAGE, COLS_PER_ROW } = require('../utils/duplexPrint');

test('mirrorPage', async (t) => {
  await t.test('reverses column order within a full 2-item row', () => {
    assert.deepEqual(mirrorPage(['A', 'B']), ['B', 'A']);
  });

  await t.test('pads a lone last-row item with a leading blank instead of leaving it in column 0', () => {
    // A single trailing card occupies column 0 on the front (it's the
    // first/only card placed in that row) - its mirrored back-page slot
    // must be column 1, with column 0 left blank, or it would land under
    // whatever WAS in column 1 on the front (nothing) instead of lining
    // up with itself once the sheet is flipped.
    assert.deepEqual(mirrorPage(['G']), [null, 'G']);
  });

  await t.test('mirrors multiple rows independently, including a mixed full+partial page', () => {
    assert.deepEqual(mirrorPage(['A', 'B', 'C', 'D', 'E']), ['B', 'A', 'D', 'C', null, 'E']);
  });

  await t.test('an empty page mirrors to an empty page', () => {
    assert.deepEqual(mirrorPage([]), []);
  });
});

test('buildDuplexPages', async (t) => {
  function pair(name) {
    return { nameTag: { html: `<nt-${name}>`, bgCss: 'red' }, scheduleCard: { html: `<sc-${name}>`, bgCss: 'blue' } };
  }

  await t.test('constants match the physical 2x4, 8-per-sheet card grid', () => {
    assert.equal(COLS_PER_ROW, 2);
    assert.equal(CARDS_PER_PAGE, 8);
  });

  await t.test('splits into one front/back page pair for up to 8 members', () => {
    const pairs = ['A', 'B', 'C'].map(pair);
    const { frontPages, backPages } = buildDuplexPages(pairs);
    assert.equal(frontPages.length, 1);
    assert.equal(backPages.length, 1);
    assert.deepEqual(
      frontPages[0].map((c) => c.html),
      ['<nt-A>', '<nt-B>', '<nt-C>']
    );
    // Row 0 (A, B) mirrors to (B, A); row 1's lone C mirrors to (blank, C).
    assert.deepEqual(
      backPages[0].map((c) => (c ? c.html : null)),
      ['<sc-B>', '<sc-A>', null, '<sc-C>']
    );
  });

  await t.test('a 9th member starts a second front/back page pair, each mirrored independently', () => {
    const names = 'ABCDEFGHI'.split('');
    const pairs = names.map(pair);
    const { frontPages, backPages } = buildDuplexPages(pairs);
    assert.equal(frontPages.length, 2);
    assert.equal(backPages.length, 2);
    assert.equal(frontPages[0].length, 8);
    assert.equal(frontPages[1].length, 1);
    assert.deepEqual(
      frontPages[1].map((c) => c.html),
      ['<nt-I>']
    );
    // The lone member on page 2 mirrors the same way a lone last row does
    // on page 1 - each page's mirroring is independent of the others.
    assert.deepEqual(
      backPages[1].map((c) => (c ? c.html : null)),
      [null, '<sc-I>']
    );
  });

  await t.test('an empty selection produces no pages', () => {
    const { frontPages, backPages } = buildDuplexPages([]);
    assert.deepEqual(frontPages, []);
    assert.deepEqual(backPages, []);
  });
});
