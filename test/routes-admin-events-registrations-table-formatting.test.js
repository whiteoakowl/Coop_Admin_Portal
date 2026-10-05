// A real request on the event Registrations table (views/admin-events-
// registrations.ejs): "Cancel buttons the text should fit properly in
// the box. And the button should sit next to the trash button. Column
// titles should be two rows to condense. Date and time should be August
// 2, 2026, 9:54pm."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-registrations-table-formatting-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-registrations-table-formatting-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Table Formatting Test Event', startsAt: '2027-11-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

test('Registered/Checked In/Checked Out render as "Month Day, Year, H:MMam/pm" (Eastern), not the raw stored timestamp', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const code = await generateMemberCode();
  const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)").run('Formatting Test Member', code, code);
  // 2026-08-03 01:54:00 UTC is 2026-08-02 9:54pm Eastern (EDT, UTC-4).
  const regInfo = await db
    .prepare("INSERT INTO event_registrations (event_id, member_id, status, created_at, checked_in_at, checked_out_at) VALUES (?, ?, 'confirmed', '2026-08-03 01:54:00', '2026-08-03 02:00:00', '2026-08-03 03:00:00')")
    .run(eventId, memberInfo.lastInsertRowid);

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /August 2, 2026, 9:54pm/);
  assert.doesNotMatch(page.text, /2026-08-03 01:54:00/);
  assert.match(page.text, /August 2, 2026, 10:00pm/);
  assert.match(page.text, /August 2, 2026, 11:00pm/);
  assert.ok(regInfo.lastInsertRowid);
});

test('column headers wrap onto two lines to condense the table, and the Cancel button sits next to the trash button without an oversized box', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const code = await generateMemberCode();
  const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)").run('Formatting Test Member 2', code, code);
  const regInfo = await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, memberInfo.lastInsertRowid);

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<th>Checked<br>In<\/th>/);
  assert.match(page.text, /<th>Checked<br>Out<\/th>/);
  assert.doesNotMatch(page.text, /<th>Checked In<\/th>/);
  assert.doesNotMatch(page.text, /<th>Checked Out<\/th>/);

  const rowMatch = new RegExp(`data-registration-row="${regInfo.lastInsertRowid}"[\\s\\S]*?</tr>`).exec(page.text);
  assert.ok(rowMatch, 'expected the registration row');
  assert.match(rowMatch[0], /class="roster-btn-row roster-btn-row-nowrap"/);
  assert.match(rowMatch[0], /class="roster-action-btn roster-action-btn-small roster-action-btn-fit js-registration-cancel"/);
});
