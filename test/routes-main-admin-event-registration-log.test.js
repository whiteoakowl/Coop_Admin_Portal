// A real request: "Main admin portal, events tab. Add a subapage called
// event registration log. Here it will record every time a member
// registers for an event or cancels[,] organized by date and then by
// family." Covers utils/events.js's allEventRegistrationActions (the
// register/cancel -> up-to-two-synthetic-rows math) and routes/admin-
// events.js's groupEventRegistrationActionsByDate (true two-level date ->
// family grouping), reached through the real tab=registrationlog route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `event-reg-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `event-reg-log-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

let eventId;
let familyAnderson;
let familyBaker;
let memberAlice; // registers 3/1, cancels 3/2
let memberAndy; // registers 3/1, stays confirmed - same family as Alice
let memberBob; // registers 3/2, stays waitlisted

test.before(async () => {
  await app.ready;
  const ev = await db
    .prepare("INSERT INTO events (title, starts_at, status, visibility) VALUES ('Fall Festival', '2024-03-04 10:00:00', 'published', 'members')")
    .run();
  eventId = ev.lastInsertRowid;

  familyAnderson = (await db.prepare("INSERT INTO families (name) VALUES ('Anderson Family')").run()).lastInsertRowid;
  familyBaker = (await db.prepare("INSERT INTO families (name) VALUES ('Baker Family')").run()).lastInsertRowid;

  memberAlice = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Alice Anderson', 'ereg-alice', 'parent', ?)").run(familyAnderson)
  ).lastInsertRowid;
  memberAndy = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Andy Anderson', 'ereg-andy', 'student', ?)").run(familyAnderson)
  ).lastInsertRowid;
  memberBob = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Bob Baker', 'ereg-bob', 'parent', ?)").run(familyBaker)
  ).lastInsertRowid;

  await db
    .prepare(
      "INSERT INTO event_registrations (event_id, member_id, status, created_at, cancelled_at) VALUES (?, ?, 'cancelled', '2024-03-01 09:00:00', '2024-03-02 14:30:00')"
    )
    .run(eventId, memberAlice);
  await db
    .prepare("INSERT INTO event_registrations (event_id, member_id, status, created_at) VALUES (?, ?, 'confirmed', '2024-03-01 09:05:00')")
    .run(eventId, memberAndy);
  await db
    .prepare("INSERT INTO event_registrations (event_id, member_id, status, created_at) VALUES (?, ?, 'waitlisted', '2024-03-02 11:00:00')")
    .run(eventId, memberBob);
});

test('Main Admin Events > Event Registration Log (tab=registrationlog)', async (t) => {
  const cookie = await loginAsMainAdmin();

  await t.test('a cancelled registration produces two separate log entries - one at register time, one at cancel time', async () => {
    const csv = await request(app).get('/main-admin/events/registrationlog/export.csv').set('Cookie', cookie);
    assert.equal(csv.status, 200);
    const aliceRows = csv.text.split('\n').filter((l) => l.includes('Alice Anderson'));
    assert.equal(aliceRows.length, 2, 'expected a Registered row and a separate Cancelled row for the same registration');
    assert.ok(aliceRows.some((l) => l.includes('"Registered"')), 'expected one row labeled Registered');
    assert.ok(aliceRows.some((l) => l.includes('"Cancelled"')), 'expected one row labeled Cancelled');
  });

  await t.test('a still-confirmed registration produces exactly one Registered row, never a Cancelled one', async () => {
    const csv = await request(app).get('/main-admin/events/registrationlog/export.csv').set('Cookie', cookie);
    const andyRows = csv.text.split('\n').filter((l) => l.includes('Andy Anderson'));
    assert.equal(andyRows.length, 1);
    assert.match(andyRows[0], /"Registered"/);
  });

  await t.test('a still-waitlisted registration is labeled Waitlisted, not the generic Registered', async () => {
    const csv = await request(app).get('/main-admin/events/registrationlog/export.csv').set('Cookie', cookie);
    const bobRow = csv.text.split('\n').find((l) => l.includes('Bob Baker'));
    assert.match(bobRow, /"Waitlisted"/);
  });

  await t.test('the on-screen log groups by date, then by family, within the right date', async () => {
    const res = await request(app).get('/main-admin/events?tab=registrationlog').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Event Registration Log/);
    assert.match(res.text, /Alice Anderson/);
    assert.match(res.text, /Andy Anderson/);
    assert.match(res.text, /Bob Baker/);
    assert.match(res.text, /Anderson Family/);
    assert.match(res.text, /Baker Family/);
  });

  await t.test('the date filter narrows the log to just that date', async () => {
    const res = await request(app).get('/main-admin/events?tab=registrationlog&date=2024-03-01').set('Cookie', cookie);
    assert.equal(res.status, 200);
    // 3/1 is when Alice and Andy registered - Bob only ever appears on 3/2.
    assert.match(res.text, /Alice Anderson/);
    assert.doesNotMatch(res.text, /Bob Baker/);
  });

  await t.test('the Event Registration Log nav link is wired up', async () => {
    const res = await request(app).get('/main-admin/events').set('Cookie', cookie);
    assert.match(res.text, /tab=registrationlog/);
    assert.match(res.text, /Event Registration Log/);
  });

  await t.test('the Print button on the live log is a link to a dedicated print preview page', async () => {
    const res = await request(app).get('/main-admin/events?tab=registrationlog').set('Cookie', cookie);
    assert.match(res.text, /<a class="icon-btn" href="\/main-admin\/events\/registrationlog\/print" target="_blank" aria-label="Print"/);
  });

  await t.test('GET /main-admin/events/registrationlog/print renders a print preview with every log row', async () => {
    const res = await request(app).get('/main-admin/events/registrationlog/print').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /print-preview-header/);
    assert.match(res.text, /onclick="window\.print\(\)"/);
    assert.match(res.text, /Alice Anderson/);
    assert.match(res.text, /Bob Baker/);
  });

  await t.test('the date filter narrows the print preview to just that date too', async () => {
    const res = await request(app).get('/main-admin/events/registrationlog/print?date=2024-03-01').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Alice Anderson/);
    assert.doesNotMatch(res.text, /Bob Baker/);
  });
});

test('Main Admin Events > Calendar tab print preview', async (t) => {
  const cookie = await loginAsMainAdmin();

  await t.test('the Print button on the live Calendar tab is a link to a dedicated print preview page', async () => {
    const res = await request(app).get('/main-admin/events?tab=calendar').set('Cookie', cookie);
    assert.match(res.text, /<a class="icon-btn" href="\/main-admin\/events\/print\?view=calendar&month=" target="_blank" aria-label="Print"/);
  });

  await t.test('GET /main-admin/events/print renders a print preview of the published calendar', async () => {
    const res = await request(app).get('/main-admin/events/print?month=2024-03').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /print-preview-header/);
    assert.match(res.text, /onclick="window\.print\(\)"/);
    assert.match(res.text, /Fall Festival/);
  });

  await t.test('GET /main-admin/events/print?view=list renders the list view instead', async () => {
    const res = await request(app).get('/main-admin/events/print?view=list&month=2024-03').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Fall Festival/);
  });
});
