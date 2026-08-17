// Coverage for a real request: EVERY name tag (student and parent alike)
// should stack a member's first name over their last name instead of
// running both on one line, freeing up width so the auto-fit font size
// can grow larger than a single "First Last" line could ever reach.
// splitNameLines (utils/nameTagData.js) splits on the FIRST space only,
// the same convention name-tag-render-core.js's renderTextEl already
// expects for any multi-line field (an array = one stacked line per
// entry - see gradeLevelLabel/setupCleanupJobLabels' own comments).
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitNameLines } = require('../utils/nameTagData');

test('splitNameLines splits a two-word name into [first, last]', () => {
  assert.deepEqual(splitNameLines('Jessica Adema'), ['Jessica', 'Adema']);
});

test('splitNameLines splits on the FIRST space only, keeping a multi-word last name together on the second line', () => {
  assert.deepEqual(splitNameLines('Mary Jane Smith'), ['Mary', 'Jane Smith']);
});

test('splitNameLines returns a single unstacked string for a one-word name (no space to split on)', () => {
  assert.equal(splitNameLines('Cher'), 'Cher');
});

test('splitNameLines returns an empty string for a blank/missing name', () => {
  assert.equal(splitNameLines(''), '');
  assert.equal(splitNameLines(null), '');
  assert.equal(splitNameLines(undefined), '');
});

test('splitNameLines trims surrounding whitespace on both the input and the resulting second line', () => {
  assert.deepEqual(splitNameLines('  Jessica   Adema  '), ['Jessica', 'Adema']);
});
