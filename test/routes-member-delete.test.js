// Real HTTP-level coverage for member deletion (audit finding TEST-01) -
// the one admin action that's genuinely irreversible (no undo, no
// archive trail like roster Archive has) and relies entirely on SQLite's
// ON DELETE CASCADE across a dozen-plus tables (see db/schema.sql) to
// avoid leaving orphaned attendance/checkout/roster rows behind. A
// missing CASCADE on a newly added table would fail completely silently
// - the DELETE still "succeeds", it just leaves debris - which is
// exactly the kind of regression a manual click-through won't catch.
// Boots the real app (server.js) against a throwaway DB, same override
// pattern as test/designImageGC.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-member-delete-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-member-delete-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const match = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  return { cookie, csrfToken: match ? match[1] : null };
}

test('member deletion', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  assert.ok(csrfToken, 'expected a CSRF token to be present on the rendered admin page');

  await t.test('deleting a member cascades to every table that referenced them', async () => {
    const roster = await db.prepare('SELECT id FROM rosters WHERE active = 1 LIMIT 1').get();
    const { lastInsertRowid: familyId } = await db.prepare("INSERT INTO families (name) VALUES ('Cascade Test Family')").run();
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Cascade Test Kid', 'Cascade Test Kid', 'student', ?)")
      .run(familyId);
    const today = todayISO();

    await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(roster.id, today);
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(roster.id, memberId);
    await db.prepare(
      "INSERT INTO attendance (roster_id, member_id, session_date, status, source) VALUES (?, ?, ?, 'present', 'kiosk')"
    ).run(roster.id, memberId, today);
    await db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, ?, ?)').run(
      memberId,
      roster.id,
      today,
      1,
      Date.now()
    );

    // Sanity check the fixture actually landed before deleting anything.
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM roster_members WHERE member_id = ?').get(memberId)).n), 1);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?').get(memberId)).n), 1);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE member_id = ?').get(memberId)).n), 1);

    const res = await request(app).post(`/admin/members/${memberId}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    assert.equal(await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId), undefined);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM roster_members WHERE member_id = ?').get(memberId)).n), 0);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?').get(memberId)).n), 0);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE member_id = ?').get(memberId)).n), 0);

    // The family itself is untouched - deleting one member of a family
    // was never meant to take the family record down with it.
    assert.ok(await db.prepare('SELECT * FROM families WHERE id = ?').get(familyId), 'expected the family row to survive');
  });

  await t.test('deleting an already-nonexistent member id is a harmless no-op, not a crash', async () => {
    const res = await request(app).post('/admin/members/999999/delete').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
  });

  await t.test('an unauthenticated request is rejected before reaching the delete handler at all', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Should Survive Kid', 'Should Survive Kid', 'student')")
      .run();
    const res = await request(app).post(`/admin/members/${memberId}/delete`).type('form').send({});
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/admin\/login/);
    assert.ok(await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId), 'expected the member to still exist');
  });

  await t.test('a request with a valid session but a missing/wrong CSRF token is rejected (403), member survives', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('CSRF Guard Kid', 'CSRF Guard Kid', 'student')")
      .run();
    const res = await request(app).post(`/admin/members/${memberId}/delete`).set('Cookie', cookie).type('form').send({});
    assert.equal(res.status, 403);
    assert.ok(await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId), 'expected the member to still exist');
  });
});
