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
const fs = require('fs');
const os = require('os');
const path = require('path');

// A real bug this file itself had: unlike every sibling nameTag*.test.js
// file, it never set DB_PATH before requiring utils/nameTagData.js (whose
// own top-level `require('../db')` needs it) - so it silently fell
// through to db/index.js's "DB_PATH unset" branch, which opens the real
// PERSISTENT on-disk PGlite instance at data/pglite (the one a plain
// `node server.js` run actually uses) instead of an isolated throwaway
// one. Harmless when nothing else has that directory open, but a real
// hang once something else does (PGlite's own file lock never clears) -
// confirmed live: this file hung indefinitely under exactly that
// condition. splitNameLines itself needs no database at all; this is
// purely about not touching the real one just by requiring its module.
const testDbPath = path.join(os.tmpdir(), `name-tag-split-name-lines-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const { splitNameLines } = require('../utils/nameTagData');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
});

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
