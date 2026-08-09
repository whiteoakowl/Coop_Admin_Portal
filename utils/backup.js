const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

module.exports = { backupDatabaseBuffer };
