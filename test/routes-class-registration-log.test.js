// A real request: "Co-op admin portal, classes tab, add a sub page
// called class registration log, setup the same way as I described the
// new event log" - record every time a member registers for a class or
// cancels, organized by date and then by family. Covers utils/
// classRegistration.js's allClassRegistrationActions (the register/cancel
// -> up-to-two-synthetic-rows math, same shape utils/events.js's own
// allEventRegistrationActions established) and routes/admin-schedule.js's
// groupClassRegistrationActionsByDate (true two-level date -> family
// grouping), reached through the real tab=classregistrationlog route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-reg-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-reg-log-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

let classId;
let accountId;
let familyAnderson;
let familyBaker;
let studentAndy; // registers 3/1, cancels 3/2
let studentAlice; // registers 3/1, stays confirmed - same family as Andy
let studentBob; // registers 3/2, stays waitlisted

test.before(async () => {
  await app.ready;
  classId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Intro to Chemistry', 'monday', 1)").run()
  ).lastInsertRowid;

  familyAnderson = (await db.prepare("INSERT INTO families (name) VALUES ('Anderson Family')").run()).lastInsertRowid;
  familyBaker = (await db.prepare("INSERT INTO families (name) VALUES ('Baker Family')").run()).lastInsertRowid;

  studentAndy = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Andy Anderson', 'creg-andy', 'student', ?)").run(familyAnderson)
  ).lastInsertRowid;
  studentAlice = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Alice Anderson', 'creg-alice', 'student', ?)").run(familyAnderson)
  ).lastInsertRowid;
  studentBob = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Bob Baker', 'creg-bob', 'student', ?)").run(familyBaker)
  ).lastInsertRowid;

  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Parent Anderson', 'creg-parent', 'parent', ?)").run(familyAnderson)
  ).lastInsertRowid;
  accountId = (
    await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'creg-parent@test.local', 'x', 'active')").run(parentId)
  ).lastInsertRowid;

  await db
    .prepare(
      "INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, created_at, cancelled_at) VALUES (?, ?, ?, 'cancelled', '2024-03-01 09:00:00', '2024-03-02 14:30:00')"
    )
    .run(classId, studentAndy, accountId);
  await db
    .prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, created_at) VALUES (?, ?, ?, 'confirmed', '2024-03-01 09:05:00')")
    .run(classId, studentAlice, accountId);
  await db
    .prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, created_at) VALUES (?, ?, ?, 'waitlisted', '2024-03-02 11:00:00')")
    .run(classId, studentBob, accountId);
});

test('Co-op Admin Classes > Class Registration Log (tab=classregistrationlog)', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('a cancelled registration produces two separate log entries - one at register time, one at cancel time', async () => {
    const csv = await request(app).get('/admin/schedule/classregistrationlog/export.csv').set('Cookie', cookie);
    assert.equal(csv.status, 200);
    const andyRows = csv.text.split('\n').filter((l) => l.includes('Andy Anderson'));
    assert.equal(andyRows.length, 2, 'expected a Registered row and a separate Cancelled row for the same registration');
    assert.ok(andyRows.some((l) => l.includes('"Registered"')));
    assert.ok(andyRows.some((l) => l.includes('"Cancelled"')));
  });

  await t.test('a still-confirmed registration produces exactly one Registered row, never a Cancelled one', async () => {
    const csv = await request(app).get('/admin/schedule/classregistrationlog/export.csv').set('Cookie', cookie);
    const aliceRows = csv.text.split('\n').filter((l) => l.includes('Alice Anderson'));
    assert.equal(aliceRows.length, 1);
    assert.match(aliceRows[0], /"Registered"/);
  });

  await t.test('a still-waitlisted registration is labeled Waitlisted, not the generic Registered', async () => {
    const csv = await request(app).get('/admin/schedule/classregistrationlog/export.csv').set('Cookie', cookie);
    const bobRow = csv.text.split('\n').find((l) => l.includes('Bob Baker'));
    assert.match(bobRow, /"Waitlisted"/);
  });

  await t.test('the on-screen log groups by date, then by family', async () => {
    const res = await request(app).get('/admin/schedule?tab=classregistrationlog').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Class Registration Log/);
    assert.match(res.text, /Andy Anderson/);
    assert.match(res.text, /Alice Anderson/);
    assert.match(res.text, /Bob Baker/);
    assert.match(res.text, /Anderson Family/);
    assert.match(res.text, /Baker Family/);
  });

  await t.test('the date filter narrows the log to just that date', async () => {
    const res = await request(app).get('/admin/schedule?tab=classregistrationlog&date=2024-03-01').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Andy Anderson/);
    assert.doesNotMatch(res.text, /Bob Baker/);
  });

  await t.test('the Class Registration Log nav link is wired up', async () => {
    const res = await request(app).get('/admin/schedule').set('Cookie', cookie);
    assert.match(res.text, /tab=classregistrationlog/);
    assert.match(res.text, /Class Registration Log/);
  });
});
