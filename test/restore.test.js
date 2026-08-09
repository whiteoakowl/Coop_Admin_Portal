// Real unit + integration coverage for the backup/restore feature. See
// utils/backup.js's own comments for the design rationale - most
// importantly, why a restore only takes effect on the app's *next*
// startup rather than being swapped in live.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// utils/backup.js requires ../db, which opens (and migrates/seeds) a real
// database file on require - point it at a private, throwaway location so
// this test never touches whatever data/attendance.db a developer or CI
// run already has.
const testDbPath = path.join(os.tmpdir(), `restore-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;
const { backupDatabaseBuffer, stageRestore, isRestoreStaged, cancelStagedRestore } = require('../utils/backup');
const db = require('../db');

test('backup/restore', async (t) => {
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm', '.restore-pending']) {
      fs.rmSync(`${testDbPath}${suffix}`, { force: true });
    }
  });

  await t.test('rejects a file that is not a SQLite database at all', () => {
    assert.throws(() => stageRestore(Buffer.from('not a database')), /not a valid SQLite database/);
    assert.equal(isRestoreStaged(), false);
  });

  await t.test("rejects a real SQLite file that isn't this app's database", () => {
    const wrongPath = path.join(os.tmpdir(), `restore-test-wrong-${process.pid}.db`);
    fs.rmSync(wrongPath, { force: true });
    const wrongDb = new DatabaseSync(wrongPath);
    wrongDb.exec('CREATE TABLE unrelated (id INTEGER)');
    wrongDb.close();
    try {
      assert.throws(() => stageRestore(fs.readFileSync(wrongPath)), /doesn't look like a backup/);
      assert.equal(isRestoreStaged(), false);
    } finally {
      fs.rmSync(wrongPath, { force: true });
    }
  });

  await t.test('rejects a backup with zero admin accounts', () => {
    const zeroAdminPath = path.join(os.tmpdir(), `restore-test-zeroadmin-${process.pid}.db`);
    fs.rmSync(zeroAdminPath, { force: true });
    const zaDb = new DatabaseSync(zeroAdminPath);
    zaDb.exec('CREATE TABLE admins (id INTEGER)');
    zaDb.exec('CREATE TABLE members (id INTEGER)');
    zaDb.exec('CREATE TABLE rosters (id INTEGER)');
    zaDb.close();
    try {
      assert.throws(() => stageRestore(fs.readFileSync(zeroAdminPath)), /no admin account/);
      assert.equal(isRestoreStaged(), false);
    } finally {
      fs.rmSync(zeroAdminPath, { force: true });
    }
  });

  await t.test('a real backup of the live database stages successfully, and cancel un-stages it', () => {
    const buffer = backupDatabaseBuffer();
    stageRestore(buffer);
    assert.equal(isRestoreStaged(), true);
    cancelStagedRestore();
    assert.equal(isRestoreStaged(), false);
  });

  await t.test('a staged restore is swapped in on the next process startup', () => {
    // Stage a restore of a known, distinct value so the swap is
    // observable: change the live admin username, snapshot that as the
    // "backup" to restore, change it again, stage the snapshot, then boot
    // a real child process (mirroring an actual app restart, the only
    // way this feature is ever meant to apply) and confirm db/index.js's
    // startup-time swap put the snapshotted value back - not this test's
    // own already-loaded module cache, which wouldn't exercise it at all.
    const adminId = db.prepare('SELECT id FROM admins LIMIT 1').get().id;
    db.prepare('UPDATE admins SET username = ? WHERE id = ?').run('before-restore', adminId);
    const snapshot = backupDatabaseBuffer();
    db.prepare('UPDATE admins SET username = ? WHERE id = ?').run('after-restore-should-be-overwritten', adminId);
    stageRestore(snapshot);
    assert.equal(isRestoreStaged(), true);

    const dbIndexPath = path.join(__dirname, '..', 'db', 'index.js');
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(dbIndexPath)})`], {
      env: { ...process.env, DB_PATH: testDbPath },
    });

    assert.equal(isRestoreStaged(), false, 'the staged file should be consumed by the swap');
    const after = new DatabaseSync(testDbPath);
    const username = after.prepare('SELECT username FROM admins WHERE id = ?').get(adminId).username;
    after.close();
    assert.equal(username, 'before-restore');
  });
});
