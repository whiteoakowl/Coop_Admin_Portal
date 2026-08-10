// A minimal express-session Store backed by the app's own SQLite database
// (db/schema.sql's `sessions` table) instead of the express-session
// default (an in-memory MemoryStore, which loses every admin session on
// restart/deploy and never evicts anything on its own - both flagged by
// the audit this was built from). Written by hand against express-session's
// documented Store interface rather than pulling in a connect-sqlite3 /
// similar package: this app already has exactly one SQLite connection
// (node:sqlite's DatabaseSync, via db/index.js) and no existing session-
// store package targets that driver - a second SQLite dependency (most
// packages in this space wrap the classic `sqlite3` native binding) would
// mean two separate database drivers/connections/files for what's really
// one small table, for no real benefit over ~80 lines of plain SQL.
//
// Only implements what express-session actually calls in this app's
// setup (get/set/destroy/touch) - not the optional all/length/clear
// methods, which nothing here uses (e.g. no admin "log out everywhere"
// feature exists to need Store#all).
const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this._getStmt = db.prepare('SELECT data_json, expires_at FROM sessions WHERE sid = ?');
    this._setStmt = db.prepare(
      'INSERT INTO sessions (sid, data_json, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET data_json = excluded.data_json, expires_at = excluded.expires_at'
    );
    this._touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this._destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

    // Expired rows are also filtered out on read (get(), below) - this
    // sweep is only so a session nobody ever comes back to actually
    // gets removed instead of sitting in the table forever. Same
    // unref()'d setInterval pattern as utils/loginRateLimit.js's own
    // periodic cleanup, and for the same reason: never keeps the
    // process alive on its own.
    setInterval(() => this._sweepStmt.run(Date.now()), 60 * 60 * 1000).unref();
  }

  // A session with no explicit cookie.expires (shouldn't happen given
  // server.js always sets cookie.maxAge, but Store#get's contract
  // doesn't guarantee it) gets a conservative 1-day fallback rather than
  // being treated as never-expiring.
  static _expiresAtFor(sessionData) {
    const expires = sessionData.cookie && sessionData.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  }

  get(sid, callback) {
    let row;
    try {
      row = this._getStmt.get(sid);
    } catch (err) {
      return callback(err);
    }
    if (!row || row.expires_at < Date.now()) return callback(null, null);
    try {
      callback(null, JSON.parse(row.data_json));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      this._setStmt.run(sid, JSON.stringify(sessionData), SqliteSessionStore._expiresAtFor(sessionData));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    try {
      this._touchStmt.run(SqliteSessionStore._expiresAtFor(sessionData), sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this._destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
