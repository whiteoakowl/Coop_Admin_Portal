// Real unit + integration coverage for the backup package format - the
// database bundled together with every uploaded file (member photos,
// documents, design images). See utils/backup.js's own comments for the
// full design (why a purpose-built pack format instead of a real .zip,
// why the swap only applies at the next startup).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// Both overridable the same way db/index.js's DB_PATH already is - point
// them at private, throwaway locations so this test never touches
// whatever data/attendance.db or public/uploads/ a developer or CI run
// already has.
const testDbPath = path.join(os.tmpdir(), `backup-package-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `backup-package-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;

const { backupPackageBuffer, stageRestore, isRestoreStaged, cancelStagedRestore } = require('../utils/backup');
const db = require('../db');

function writeTestUpload(relativePath, content) {
  const fullPath = path.join(testUploadsDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

test('backupPackageBuffer / restore, including uploaded files', async (t) => {
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm', '.restore-pending']) {
      fs.rmSync(`${testDbPath}${suffix}`, { force: true });
    }
    fs.rmSync(testUploadsDir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(testDbPath), 'uploads-restore-pending'), { recursive: true, force: true });
  });

  await t.test('the package includes both the database and every uploaded file', () => {
    writeTestUpload('members/photo1.jpg', Buffer.from('fake jpeg bytes'));
    writeTestUpload('documents/handbook.pdf', Buffer.from('fake pdf bytes'));

    const buffer = backupPackageBuffer();
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 0);

    // A packed buffer is gzip-compressed, not a raw SQLite file - it
    // should NOT open directly as a database (that's exactly the
    // distinction stageRestore's format detection relies on).
    const tmpPath = path.join(os.tmpdir(), `not-a-db-${process.pid}.db`);
    fs.writeFileSync(tmpPath, buffer);
    try {
      assert.throws(() => {
        const d = new DatabaseSync(tmpPath);
        d.prepare('PRAGMA integrity_check').get();
      });
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });

  await t.test('staging a packed backup restores both the database and the uploaded files on next startup', () => {
    // Snapshot the live db + uploads at a known state, change both, stage
    // the earlier snapshot as a restore, then boot a real child process
    // (mirroring an actual app restart) and confirm both the database
    // AND the uploaded files were put back - not just the database,
    // which the previous (pre-this-feature) restore already covered.
    const adminId = db.prepare('SELECT id FROM admins LIMIT 1').get().id;
    db.prepare('UPDATE admins SET username = ? WHERE id = ?').run('before-restore', adminId);
    writeTestUpload('members/keeper.jpg', Buffer.from('the photo that should survive restore'));

    const snapshot = backupPackageBuffer();

    db.prepare('UPDATE admins SET username = ? WHERE id = ?').run('after-restore-should-be-overwritten', adminId);
    fs.rmSync(path.join(testUploadsDir, 'members', 'keeper.jpg'), { force: true });
    writeTestUpload('members/interloper.jpg', Buffer.from('a file that should NOT survive restore'));

    stageRestore(snapshot);
    assert.equal(isRestoreStaged(), true);

    const dbIndexPath = path.join(__dirname, '..', 'db', 'index.js');
    const backupModulePath = path.join(__dirname, '..', 'utils', 'backup.js');
    execFileSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(dbIndexPath)}); require(${JSON.stringify(backupModulePath)}).applyPendingUploadsRestore();`],
      { env: { ...process.env, DB_PATH: testDbPath, UPLOADS_DIR: testUploadsDir } }
    );

    assert.equal(isRestoreStaged(), false, 'the staged db file should be consumed by the swap');

    const after = new DatabaseSync(testDbPath);
    const username = after.prepare('SELECT username FROM admins WHERE id = ?').get(adminId).username;
    after.close();
    assert.equal(username, 'before-restore');

    assert.equal(fs.existsSync(path.join(testUploadsDir, 'members', 'keeper.jpg')), true, 'the snapshotted file should have been restored');
    assert.equal(
      fs.readFileSync(path.join(testUploadsDir, 'members', 'keeper.jpg'), 'utf8'),
      'the photo that should survive restore'
    );
    assert.equal(
      fs.existsSync(path.join(testUploadsDir, 'members', 'interloper.jpg')),
      false,
      'a file added after the snapshot should not survive - restore replaces uploads/ wholesale, same as the database'
    );
  });

  await t.test('cancelling a staged restore also clears the staged uploads', () => {
    writeTestUpload('members/whatever.jpg', Buffer.from('whatever'));
    stageRestore(backupPackageBuffer());
    assert.equal(isRestoreStaged(), true);
    const pendingUploadsDir = path.join(path.dirname(testDbPath), 'uploads-restore-pending');
    assert.equal(fs.existsSync(pendingUploadsDir), true);

    cancelStagedRestore();
    assert.equal(isRestoreStaged(), false);
    assert.equal(fs.existsSync(pendingUploadsDir), false);
  });

  await t.test('an old-format, database-only backup still restores (backward compatibility)', () => {
    // A backup downloaded before this feature shipped is a bare SQLite
    // file, not a pack. It should still validate and stage exactly as it
    // always did - just without touching uploads/, since it never
    // captured any.
    const { backupDatabaseBuffer } = require('../utils/backup');
    const bareDbBuffer = backupDatabaseBuffer();
    assert.doesNotThrow(() => stageRestore(bareDbBuffer));
    assert.equal(isRestoreStaged(), true);
    cancelStagedRestore();
  });
});
