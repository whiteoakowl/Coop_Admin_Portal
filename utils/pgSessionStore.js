// Postgres/Supabase replacement for utils/sqliteSessionStore.js - same
// express-session Store interface, same `sessions` table shape (see
// supabase/migrations/20260811035644_initial_schema.sql), just built on
// db/postgres.js's async .prepare().get()/.run() instead of node:sqlite's
// synchronous calls. express-session's Store methods are callback-based
// regardless of what's underneath them, so the only real change from the
// SQLite version is `async` bodies that call the callback once the
// Postgres round-trip resolves, instead of calling it immediately after a
// synchronous call returns.
const session = require('express-session');

class PgSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    // Cheap to do up front, same as the SQLite version - db.prepare()
    // here doesn't touch the network itself, only .get()/.all()/.run() do.
    this._getStmt = db.prepare('SELECT data_json, expires_at FROM sessions WHERE sid = ?');
    this._setStmt = db.prepare(
      'INSERT INTO sessions (sid, data_json, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (sid) DO UPDATE SET data_json = excluded.data_json, expires_at = excluded.expires_at'
    );
    this._touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this._destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

    // Same unref()'d periodic sweep as the SQLite version and for the same
    // reason (a session nobody returns to should eventually be removed,
    // not just filtered out on read) - wrapped so a transient DB hiccup on
    // one sweep can't crash the process via an unhandled rejection.
    setInterval(() => {
      this._sweepStmt.run(Date.now()).catch((err) => console.error('Session sweep failed:', err.message));
    }, 60 * 60 * 1000).unref();
  }

  static _expiresAtFor(sessionData) {
    const expires = sessionData.cookie && sessionData.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  }

  async get(sid, callback) {
    let row;
    try {
      row = await this._getStmt.get(sid);
    } catch (err) {
      return callback(err);
    }
    if (!row || Number(row.expires_at) < Date.now()) return callback(null, null);
    try {
      callback(null, JSON.parse(row.data_json));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      await this._setStmt.run(sid, JSON.stringify(sessionData), PgSessionStore._expiresAtFor(sessionData));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async touch(sid, sessionData, callback) {
    try {
      await this._touchStmt.run(PgSessionStore._expiresAtFor(sessionData), sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await this._destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = PgSessionStore;
