// A real bug report, found while generalizing the rest of the app off the
// old 2-day utils/days.js: Name Tags/Badges still assumed exactly
// Monday/Wednesday in several places - the public Name Tag Form's own
// "Schedule Change" day radios (views/name-tag.ejs, routes/name-tag.js),
// name_tag_requests' own day CHECK constraint (which would have rejected
// any other day even if the form had offered one), the admin Name Tag
// Requests log's day label, and the Playground Check-In QR print pages
// (routes/admin-design.js and routes/main-admin-name-tags.js both looped
// a hardcoded 2-day list). Covers all of it for a 3rd day (Tuesday).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tags-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tags-day-settings-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function activateTuesday() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: csrfToken });
  return cookie;
}

test('Name Tag Form offers Tuesday once activated, and a Tuesday request can be submitted and read back', async () => {
  await activateTuesday();

  const formPage = await request(app).get('/name-tag');
  assert.equal(formPage.status, 200);
  assert.match(formPage.text, /value="tuesday"/);
  assert.match(formPage.text, />\s*Tuesday\s*</);

  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Parent', 'Tuesday Parent', 'parent')")
    .run();

  const submit = await request(app)
    .post('/name-tag/submit')
    .type('form')
    .send({ memberId: String(parentId), memberIds: [String(parentId)], requestType: 'schedule_change', day: 'tuesday', description: 'New Tuesday class' });
  assert.equal(submit.status, 200);
  assert.match(submit.text, /Request submitted/);

  const row = await db.prepare("SELECT * FROM name_tag_requests WHERE day = 'tuesday'").get();
  assert.ok(row, 'the Tuesday request should have been saved, not rejected by a stale CHECK constraint');

  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const adminPage = await request(app).get('/admin/name-tag?tab=requests').set('Cookie', cookie);
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.text, /Tuesday/);
});

test('Playground QR print pages include Tuesday once activated (Co-op Admin and Main Admin)', async () => {
  const cookie = await activateTuesday();

  const coopAdminQr = await request(app).get('/admin/design/print-playground-qr').set('Cookie', cookie);
  assert.equal(coopAdminQr.status, 200);
  assert.match(coopAdminQr.text, /Tuesday/);
  assert.match(coopAdminQr.text, /\/kiosk\/class-checkin\/playground\/tuesday\/1\/attendance/);

  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const mainAdminCookie = loginRes.headers['set-cookie'];
  const mainAdminQr = await request(app).get('/main-admin/name-tags/print-playground-qr').set('Cookie', mainAdminCookie);
  assert.equal(mainAdminQr.status, 200);
  assert.match(mainAdminQr.text, /Tuesday/);
  assert.match(mainAdminQr.text, /\/kiosk\/class-checkin\/playground\/tuesday\/1\/attendance/);
});
