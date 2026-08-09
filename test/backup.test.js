// Real unit coverage for the database backup feature (see utils/backup.js
// for the full rationale on VACUUM INTO vs a raw file copy). Runs against
// this test run's actual DB_PATH (set by the test runner's environment,
// same DB the rest of the app would use) rather than a fixture, so it
// doubles as a check that VACUUM INTO keeps working against a real,
// already-migrated schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// utils/backup.js requires ../db, which opens (and migrates) a real
// database file on require - point it at a private, throwaway location so
// this test never touches whatever data/attendance.db a developer or CI
// run already has.
const testDbPath = path.join(os.tmpdir(), `backup-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;

// Also give this test file its own private os.tmpdir() (Node reads
// TMPDIR fresh on every call, not just at startup). backupDatabaseBuffer
// and test/restore.test.js's own calls to it both stage their working
// file in the *real* shared tmpdir with an `attendance-backup-` prefix -
// node's test runner runs test files concurrently, so without this, the
// "leaves no temp file behind" check below can catch another test file's
// in-flight file and fail on a false leftover that was never this file's.
const privateTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-tmp-'));
process.env.TMPDIR = privateTmpDir;

const { backupDatabaseBuffer } = require('../utils/backup');

test('backupDatabaseBuffer', async (t) => {
  t.after(() => {
    fs.rmSync(testDbPath, { force: true });
    fs.rmSync(`${testDbPath}-wal`, { force: true });
    fs.rmSync(`${testDbPath}-shm`, { force: true });
    fs.rmSync(privateTmpDir, { recursive: true, force: true });
  });

  await t.test('returns a Buffer that opens as a valid, non-empty SQLite database', () => {
    const buffer = backupDatabaseBuffer();
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 0);

    const copyPath = path.join(privateTmpDir, `backup-test-copy-${process.pid}.db`);
    fs.writeFileSync(copyPath, buffer);
    try {
      const copy = new DatabaseSync(copyPath);
      const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      assert.ok(tables.length > 0, 'backup should contain the app\'s tables');
      copy.close();
    } finally {
      fs.rmSync(copyPath, { force: true });
    }
  });

  await t.test('leaves no temp file behind after a successful backup', () => {
    backupDatabaseBuffer();
    const leftover = fs.readdirSync(privateTmpDir).filter((f) => f.startsWith('attendance-backup-'));
    assert.deepEqual(leftover, [], 'no attendance-backup-*.db temp file should remain in the tmp dir');
  });
});
