// Real coverage for utils/pgSessionStore.js - the Postgres/Supabase
// replacement for utils/sqliteSessionStore.js, exercised against PGlite
// (test/pgTestDb.js) the same way test/dbPostgres.test.js exercises the
// underlying db/postgres.js layer. Tests the express-session Store
// contract directly (get/set/touch/destroy via callbacks), not through a
// real HTTP request - that's what routes-admin-*.test.js already
// exercises once this store is actually wired into server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const PgSessionStore = require('../utils/pgSessionStore');

function get(store, sid) {
  return new Promise((resolve, reject) => store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
}
function set(store, sid, data) {
  return new Promise((resolve, reject) => store.set(sid, data, (err) => (err ? reject(err) : resolve())));
}
function touch(store, sid, data) {
  return new Promise((resolve, reject) => store.touch(sid, data, (err) => (err ? reject(err) : resolve())));
}
function destroy(store, sid) {
  return new Promise((resolve, reject) => store.destroy(sid, (err) => (err ? reject(err) : resolve())));
}

function sessionExpiringInMs(ms) {
  return { adminId: 1, cookie: { expires: new Date(Date.now() + ms).toISOString() } };
}

test('PgSessionStore', async (t) => {
  const db = await createTestDb();
  t.after(() => db.end());

  await t.test('set() then get() round-trips the session data exactly', async () => {
    const store = new PgSessionStore(db);
    const data = sessionExpiringInMs(60000);
    await set(store, 'sid-1', data);
    const got = await get(store, 'sid-1');
    assert.deepEqual(got, data);
  });

  await t.test('get() on an unknown sid returns null, not an error', async () => {
    const store = new PgSessionStore(db);
    const got = await get(store, 'no-such-sid');
    assert.equal(got, null);
  });

  await t.test('get() on an expired session returns null even though the row still exists', async () => {
    const store = new PgSessionStore(db);
    await set(store, 'sid-expired', sessionExpiringInMs(-1000)); // already expired
    const got = await get(store, 'sid-expired');
    assert.equal(got, null);
  });

  await t.test('set() on an existing sid upserts (ON CONFLICT), not a duplicate-key error', async () => {
    const store = new PgSessionStore(db);
    await set(store, 'sid-2', { adminId: 1, cookie: { expires: new Date(Date.now() + 60000).toISOString() } });
    await set(store, 'sid-2', { adminId: 2, cookie: { expires: new Date(Date.now() + 60000).toISOString() } });
    const got = await get(store, 'sid-2');
    assert.equal(got.adminId, 2, 'the second set() should have overwritten the first');
  });

  await t.test('touch() extends expiry without touching the session data', async () => {
    const store = new PgSessionStore(db);
    const originalData = { adminId: 5, csrfToken: 'abc', cookie: { expires: new Date(Date.now() + 1000).toISOString() } };
    await set(store, 'sid-3', originalData);
    await touch(store, 'sid-3', { cookie: { expires: new Date(Date.now() + 60000).toISOString() } });
    const got = await get(store, 'sid-3');
    assert.equal(got.adminId, 5, 'touch() should not overwrite the stored session data, only expires_at');
    assert.equal(got.csrfToken, 'abc');
  });

  await t.test('destroy() removes the session - a subsequent get() returns null', async () => {
    const store = new PgSessionStore(db);
    await set(store, 'sid-4', sessionExpiringInMs(60000));
    assert.ok(await get(store, 'sid-4'));
    await destroy(store, 'sid-4');
    assert.equal(await get(store, 'sid-4'), null);
  });

  await t.test('a session with no cookie.expires falls back to a 1-day expiry, not never-expiring or already-expired', async () => {
    const store = new PgSessionStore(db);
    await set(store, 'sid-5', { adminId: 1 });
    const row = await db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid-5');
    const hoursFromNow = (Number(row.expires_at) - Date.now()) / (60 * 60 * 1000);
    assert.ok(hoursFromNow > 23 && hoursFromNow <= 24, `expected ~24h out, got ${hoursFromNow}h`);
  });
});
