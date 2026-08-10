const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

// Overridable the same way db/index.js's DB_PATH is, so tests can point
// this at a throwaway directory instead of the real public/uploads/.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');

// Produces a point-in-time copy of the live database as a Buffer, safe to
// run while the app is serving requests. `VACUUM INTO` is SQLite's own
// built-in atomic backup mechanism - unlike a raw fs.copyFile() on the
// live .db file, it can't ever grab a half-written page mid-transaction.
// VACUUM INTO needs a real file path (not a stream), so this writes to a
// throwaway temp file and reads it back into memory. The temp file is
// always cleaned up, even if the read throws.
function backupDatabaseBuffer() {
  const tmpPath = path.join(os.tmpdir(), `attendance-backup-${crypto.randomUUID()}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(tmpPath);
    return fs.readFileSync(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

// ---------- Pack format ----------
//
// A backup needs to carry more than just the database now - member
// photos, uploaded documents, and name tag/schedule card design images
// all live as plain files under public/uploads/, and a backup that only
// captured the database silently lost every one of them on restore. That
// calls for bundling multiple files into one downloadable blob, which is
// what a real .zip/.tar is for - but the admin never opens this file
// themselves (see stageRestore below), only ever uploads it back through
// this same app's own Restore button, so nothing here actually needs to
// be openable by a general-purpose archive tool. A tiny, purpose-built
// container - a gzip-compressed sequence of [path length][path][content
// length][content] records - does the whole job without pulling in a new
// dependency just to get real archive-format compliance nobody uses.
const PACK_MAGIC = Buffer.from('SHC1'); // Sanford Homeschoolers Check-in, pack format 1

function packEntries(entries) {
  const parts = [PACK_MAGIC];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(entries.length, 0);
  parts.push(countBuf);
  for (const { relativePath, content } of entries) {
    const pathBuf = Buffer.from(relativePath, 'utf8');
    const pathLenBuf = Buffer.alloc(4);
    pathLenBuf.writeUInt32BE(pathBuf.length, 0);
    const contentLenBuf = Buffer.alloc(8);
    contentLenBuf.writeBigUInt64BE(BigInt(content.length), 0);
    parts.push(pathLenBuf, pathBuf, contentLenBuf, content);
  }
  return zlib.gzipSync(Buffer.concat(parts));
}

// True if `buffer` looks like one of this app's pack-format backups
// (as opposed to a plain SQLite file - the format every backup was
// before this, which restore still needs to accept - see stageRestore).
function isPackedBackup(buffer) {
  try {
    return zlib.gunzipSync(buffer).subarray(0, 4).equals(PACK_MAGIC);
  } catch {
    return false;
  }
}

function unpackEntries(buffer) {
  const unzipped = zlib.gunzipSync(buffer);
  if (!unzipped.subarray(0, 4).equals(PACK_MAGIC)) {
    throw new Error('Not a recognized backup package.');
  }
  let offset = 4;
  const count = unzipped.readUInt32BE(offset);
  offset += 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const pathLen = unzipped.readUInt32BE(offset);
    offset += 4;
    const relativePath = unzipped.subarray(offset, offset + pathLen).toString('utf8');
    offset += pathLen;
    const contentLen = Number(unzipped.readBigUInt64BE(offset));
    offset += 8;
    const content = unzipped.subarray(offset, offset + contentLen);
    offset += contentLen;
    entries.push({ relativePath, content });
  }
  return entries;
}

// Every file under public/uploads/ (member photos, documents, name tag/
// schedule card design images), read into memory as {relativePath,
// content} pairs prefixed "uploads/" - member photos alone are typically
// well under a few MB total at this app's real-world scale (a single
// co-op's membership), so reading them all into memory for one backup
// request is not a concern the way it might be for a general-purpose
// file server.
function collectUploadEntries() {
  const entries = [];
  function walk(dir, relPrefix) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) walk(fullPath, relPath);
      else if (stat.isFile()) entries.push({ relativePath: `uploads/${relPath}`, content: fs.readFileSync(fullPath) });
    }
  }
  walk(UPLOADS_DIR, '');
  return entries;
}

const DB_ENTRY_PATH = 'db/attendance.db';

// The full downloadable backup: the database plus every uploaded file,
// packed together. This is what the "Back Up Now" button actually sends.
function backupPackageBuffer() {
  const entries = [{ relativePath: DB_ENTRY_PATH, content: backupDatabaseBuffer() }, ...collectUploadEntries()];
  return packEntries(entries);
}

// Tables an uploaded file must have to plausibly be a backup of *this*
// app's database, not just any .db file someone picked. Deliberately a
// small, stable subset (present since the very first schema) rather than
// every table, so a backup taken by an older version of the app still
// passes.
const REQUIRED_TABLES = ['admins', 'members', 'rosters'];

const RESTORE_PENDING_PATH = `${db.DB_PATH}.restore-pending`;
// A sibling of UPLOADS_DIR (not a path derived from db.DB_PATH's own
// directory) so it's scoped the same way UPLOADS_DIR itself already is -
// this used to live under path.dirname(db.DB_PATH) instead, which only
// coincidentally worked in production (DB_PATH and the real
// public/uploads/ both happen to live under the repo root) and actively
// broke under test: every test file's throwaway DB_PATH sits directly in
// os.tmpdir(), so path.dirname(db.DB_PATH) collapsed to the exact same
// bare os.tmpdir() for every one of them regardless of which test's own
// pid-scoped UPLOADS_DIR was in play, and this staging directory's name
// was a fixed 'uploads-restore-pending' with no pid/test scoping at all
// - a flaky cross-test collision on a shared, unscoped path
// (test/backupPackage.test.js's own restore assertions would
// intermittently fail under `npm test`'s parallel test-file execution,
// never in isolation, which is exactly this class of bug's signature).
const UPLOADS_RESTORE_PENDING_DIR = `${UPLOADS_DIR}-restore-pending`;

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

// Runs the same checks as assertIsValidBackup against a file already on
// disk at tmpPath, wrapping any lower-level SQLite failure (corrupt
// header, I/O error, etc.) in a message safe to show a non-technical
// admin directly, rather than node:sqlite's own developer-facing one.
// The original is kept as `cause` so it's still visible in server logs.
function validateDbFileOrThrow(tmpPath) {
  let candidate;
  try {
    candidate = new DatabaseSync(tmpPath);
    assertIsValidBackup(candidate);
  } catch (err) {
    if (err instanceof BackupValidationError) throw err;
    throw new Error('That file is not a valid SQLite database.', { cause: err });
  } finally {
    if (candidate) candidate.close();
  }
}

// Clears out any previously staged uploads (a re-staged restore should
// fully replace what came before, not accumulate leftovers from an
// earlier attempt) and writes `entries` (relativePath already prefixed
// "uploads/...") into a fresh staging directory, preserving their
// original nested structure.
function stageUploadEntries(entries) {
  fs.rmSync(UPLOADS_RESTORE_PENDING_DIR, { recursive: true, force: true });
  for (const { relativePath, content } of entries) {
    // relativePath looks like "uploads/members/172...jpg" - strip the
    // leading "uploads/" since UPLOADS_RESTORE_PENDING_DIR already stands
    // in for that directory, then rebuild the rest under staging.
    const withoutPrefix = relativePath.replace(/^uploads\//, '');
    const destPath = path.join(UPLOADS_RESTORE_PENDING_DIR, withoutPrefix);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
  }
}

// A backup taken before uploaded files were included in it is a bare
// SQLite file, not a pack - stages just the database, exactly as this
// function always has, so a backup someone already downloaded before
// this feature shipped still restores correctly (just without files
// that were never captured in the first place).
function stageDbOnlyRestore(buffer) {
  const tmpPath = path.join(os.tmpdir(), `attendance-restore-${crypto.randomUUID()}.db`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    validateDbFileOrThrow(tmpPath);
    fs.renameSync(tmpPath, RESTORE_PENDING_PATH);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function stagePackedRestore(buffer) {
  const entries = unpackEntries(buffer);
  const dbEntry = entries.find((e) => e.relativePath === DB_ENTRY_PATH);
  if (!dbEntry) {
    throw new BackupValidationError("That file doesn't look like a backup of this app's database.");
  }
  const tmpPath = path.join(os.tmpdir(), `attendance-restore-${crypto.randomUUID()}.db`);
  fs.writeFileSync(tmpPath, dbEntry.content);
  try {
    validateDbFileOrThrow(tmpPath);
    fs.renameSync(tmpPath, RESTORE_PENDING_PATH);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  stageUploadEntries(entries.filter((e) => e.relativePath.startsWith('uploads/')));
}

// Validates an uploaded file is really a usable backup of this app's
// database (and, for a current-format backup, its uploaded files too),
// then stages it for the swap-in that happens on the next startup (see
// db/index.js and applyPendingUploadsRestore below). Never touches the
// live database or public/uploads/ directly - this app has exactly one
// long-lived, synchronous connection to the database (shared by every
// route file), and there's no safe way to close and reopen that from
// mid-request without restructuring how every route gets its `db`.
// Restart-to-apply is a deliberate trade for staying simple and safe,
// and matches how this app is actually run day to day (SETUP.md has
// admins start/stop it by opening/closing a window) - it's not asking
// for an unfamiliar step.
//
// Throws a plain Error with a message safe to show the admin directly
// when the file fails validation. Returns nothing on success.
function stageRestore(buffer) {
  if (isPackedBackup(buffer)) {
    stagePackedRestore(buffer);
  } else {
    // Staging a bare db-only restore after a packed one was already
    // staged (or vice versa, restaging) should fully replace what came
    // before, not leave a stale uploads staging directory from an
    // earlier attempt sitting around to be applied alongside it.
    fs.rmSync(UPLOADS_RESTORE_PENDING_DIR, { recursive: true, force: true });
    stageDbOnlyRestore(buffer);
  }
}

function isRestoreStaged() {
  return fs.existsSync(RESTORE_PENDING_PATH);
}

function cancelStagedRestore() {
  fs.rmSync(RESTORE_PENDING_PATH, { force: true });
  fs.rmSync(UPLOADS_RESTORE_PENDING_DIR, { recursive: true, force: true });
}

// Called once at startup (server.js, right after the database itself has
// been opened/possibly-restored) - swaps a staged uploads restore into
// place if one exists. Runs after db/index.js's own database swap but
// still before any route file's lazy `if (!fs.existsSync(PHOTO_DIR))
// fs.mkdirSync(...)` can create/touch public/uploads/, so there's no
// window where a stale or partial uploads directory could be served.
function applyPendingUploadsRestore() {
  if (!fs.existsSync(UPLOADS_RESTORE_PENDING_DIR)) return;
  fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
  fs.renameSync(UPLOADS_RESTORE_PENDING_DIR, UPLOADS_DIR);
  console.log('Restored uploaded files (photos, documents, design images) from a staged backup.');
}

module.exports = {
  backupDatabaseBuffer,
  backupPackageBuffer,
  stageRestore,
  isRestoreStaged,
  cancelStagedRestore,
  applyPendingUploadsRestore,
};
