// Real unit coverage for utils/memberLookup.js's barcode-or-name fallback
// lookup - the Class Check-In kiosk flow's "typing the name manually"
// input method. Talks to the real db module (member queries), so needs
// its own throwaway DB, same pattern as every other test/*.test.js file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-lookup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-lookup-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;

const db = require('../db');
const { findMemberByBarcodeOrName } = require('../utils/memberLookup');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test.before(() => {
  db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Lookup Test Kid', 'lookup-test-barcode', 'student')").run();
  db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Inactive Lookup Kid', 'inactive-lookup-barcode', 'student', 0)").run();
  db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Duplicate Name Kid', 'dup-barcode-1', 'student')").run();
  db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Duplicate Name Kid', 'dup-barcode-2', 'student')").run();
});

test('findMemberByBarcodeOrName', async (t) => {
  await t.test('matches an exact barcode', () => {
    const { member, ambiguous } = findMemberByBarcodeOrName('lookup-test-barcode');
    assert.equal(member.name, 'Lookup Test Kid');
    assert.equal(ambiguous, false);
  });

  await t.test('falls back to an exact, case-insensitive name match when the barcode lookup fails', () => {
    const { member, ambiguous } = findMemberByBarcodeOrName('lookup test kid');
    assert.equal(member.name, 'Lookup Test Kid');
    assert.equal(ambiguous, false);
  });

  await t.test('trims surrounding whitespace before matching', () => {
    const { member } = findMemberByBarcodeOrName('  Lookup Test Kid  ');
    assert.equal(member.name, 'Lookup Test Kid');
  });

  await t.test('an inactive member never matches, by barcode or name', () => {
    assert.equal(findMemberByBarcodeOrName('inactive-lookup-barcode').member, null);
    assert.equal(findMemberByBarcodeOrName('Inactive Lookup Kid').member, null);
  });

  await t.test('two active members sharing an exact name is reported as ambiguous, not silently resolved', () => {
    const { member, ambiguous } = findMemberByBarcodeOrName('Duplicate Name Kid');
    assert.equal(member, null);
    assert.equal(ambiguous, true);
  });

  await t.test('a partial/substring name does not match - exact name match only', () => {
    const { member } = findMemberByBarcodeOrName('Lookup Test');
    assert.equal(member, null);
  });

  await t.test('empty or whitespace-only input matches nothing', () => {
    assert.equal(findMemberByBarcodeOrName('').member, null);
    assert.equal(findMemberByBarcodeOrName('   ').member, null);
    assert.equal(findMemberByBarcodeOrName(undefined).member, null);
  });

  await t.test('unrecognized input matches nothing', () => {
    const { member, ambiguous } = findMemberByBarcodeOrName('totally-unknown-xyz');
    assert.equal(member, null);
    assert.equal(ambiguous, false);
  });
});
