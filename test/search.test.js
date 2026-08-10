// Direct coverage for utils/search.js's globalSearch() - case-insensitivity,
// the empty-query short-circuit, and the MAX_RESULTS cap, none of which
// test/routes-search.test.js's route-level assertions happen to exercise.
// Talks to the real db module (not pure - member/library-item lookups),
// so this needs its own throwaway DB, same pattern as every other
// test/*.test.js file here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `search-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `search-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;

const db = require('../db');
const { globalSearch, MAX_RESULTS } = require('../utils/search');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('globalSearch', async (t) => {
  await t.test('an empty or whitespace-only query returns no results at all, without touching the DB search paths', () => {
    assert.deepEqual(globalSearch(''), { query: '', members: [], libraryItems: [] });
    assert.deepEqual(globalSearch('   '), { query: '', members: [], libraryItems: [] });
    assert.deepEqual(globalSearch(undefined), { query: '', members: [], libraryItems: [] });
  });

  await t.test('preserves the original casing of the query for display, while matching case-insensitively', () => {
    db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Case Insensitive Kid', 'case-insensitive-kid', 'student')").run();
    const result = globalSearch('  CASE insensitive  ');
    assert.equal(result.query, 'CASE insensitive');
    assert.equal(result.members.length, 1);
    assert.equal(result.members[0].name, 'Case Insensitive Kid');
  });

  await t.test('caps member results at MAX_RESULTS even when more match', () => {
    const insert = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')");
    for (let i = 0; i < MAX_RESULTS + 5; i++) {
      insert.run(`Capacity Test Kid ${i}`, `capacity-test-kid-${i}`);
    }
    const result = globalSearch('Capacity Test Kid');
    assert.equal(result.members.length, MAX_RESULTS);
  });

  await t.test('caps library item results at MAX_RESULTS even when more match', () => {
    const insert = db.prepare("INSERT INTO library_items (title, barcode) VALUES (?, ?)");
    for (let i = 0; i < MAX_RESULTS + 5; i++) {
      insert.run(`Capacity Test Book ${i}`, `capacity-test-book-${i}`);
    }
    const result = globalSearch('Capacity Test Book');
    assert.equal(result.libraryItems.length, MAX_RESULTS);
  });

  await t.test('an inactive member is never returned', () => {
    const id = db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Inactive Search Kid', 'inactive-search-kid', 'student', 0)").run().lastInsertRowid;
    const result = globalSearch('Inactive Search Kid');
    assert.equal(result.members.some((m) => m.id === id), false);
  });
});
