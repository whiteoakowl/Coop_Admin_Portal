const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

// Produces a point-in-time copy of the live database as a Buffer, safe to
// run while the app is serving requests. `VACUUM INTO` is SQLite's own
// built-in atomic backup mechanism - unlike a raw fs.copyFile() on the
// live .db file, it can't ever grab a half-written page mid-transaction.
// VACUUM INTO needs a real file path (not a stream), so this writes to a
// throwaway temp file and reads it back into memory, letting the route
// serve it the same way every other download in this app works
// (res.send(buffer) + Content-Disposition). The temp file is always
// cleaned up, even if the read throws.
function backupDatabaseBuffer() {
  const tmpPath = path.join(os.tmpdir(), `attendance-backup-${crypto.randomUUID()}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(tmpPath);
    return fs.readFileSync(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

// Tables an uploaded file must have to plausibly be a backup of *this*
// app's database, not just any .db file someone picked. Deliberately a
// small, stable subset (present since the very first schema) rather than
// every table, so a backup taken by an older version of the app still
// passes.
const REQUIRED_TABLES = ['admins', 'members', 'rosters'];

const RESTORE_PENDING_PATH = `${db.DB_PATH}.restore-pending`;

// Marks an error message as already safe/specific enough to show an admin
// directly, so the catch-all in stageRestore below knows not to paper over
// it with the generic "not a valid SQLite database" message.
class BackupValidationError extends Error {}

// Throws a BackupValidationError (with a message safe to show directly)
// if `candidate` isn't a usable backup of this app's database. SQLite
// only actually notices a file is garbage/not-a-database once something
// tries to read from it - opening it with `new DatabaseSync()` alone can
// succeed on any bytes - so every check here needs to be inside the same
// try/catch, not just the constructor.
function assertIsValidBackup(candidate) {
  const integrity = candidate.prepare('PRAGMA integrity_check').get();
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new BackupValidationError('That file failed a database integrity check and cannot be restored.');
  }
  const tables = new Set(
    candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length > 0) {
    throw new BackupValidationError("That file doesn't look like a backup of this app's database.");
  }
  const adminCount = candidate.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (adminCount === 0) {
    throw new BackupValidationError('That backup has no admin account in it, so restoring it would lock everyone out.');
  }
}

// Validates an uploaded file is really a usable backup of this app's
// database, then stages it for the swap-in that happens on the next
// startup (see db/index.js). Never touches the live database directly -
// this app has exactly one long-lived, synchronous connection to it
// (shared by every route file), and there's no safe way to close and
// reopen that from mid-request without restructuring how every route
// gets its `db`. Restart-to-apply is a deliberate trade for staying
// simple and safe, and matches how this app is actually run day to day
// (SETUP.md has admins start/stop it by opening/closing a window) - it's
// not asking for an unfamiliar step.
//
// Throws a plain Error with a message safe to show the admin directly
// when the file fails validation. Returns nothing on success.
function stageRestore(buffer) {
  const tmpPath = path.join(os.tmpdir(), `attendance-restore-${crypto.randomUUID()}.db`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    let candidate;
    try {
      candidate = new DatabaseSync(tmpPath);
      assertIsValidBackup(candidate);
    } catch (err) {
      if (err instanceof BackupValidationError) throw err;
      // Any lower-level failure (corrupt header, I/O error, etc.) - never
      // surface node:sqlite's own message, which is written for
      // developers, not the non-technical admin using this page. The
      // original is kept as `cause` so it's still visible to a developer
      // reading server-side logs.
      throw new Error('That file is not a valid SQLite database.', { cause: err });
    } finally {
      if (candidate) candidate.close();
    }
    fs.renameSync(tmpPath, RESTORE_PENDING_PATH);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function isRestoreStaged() {
  return fs.existsSync(RESTORE_PENDING_PATH);
}

function cancelStagedRestore() {
  fs.rmSync(RESTORE_PENDING_PATH, { force: true });
}

module.exports = { backupDatabaseBuffer, stageRestore, isRestoreStaged, cancelStagedRestore };
