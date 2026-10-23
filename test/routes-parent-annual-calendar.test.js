// Coverage for a real request: "This will also be a quick links on
// parent portal" - routes/parent-portal.js's own read-only view of
// whichever fiscal-year calendar Main Admin built (routes/main-admin-
// annual-calendar.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-annual-calendar-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-annual-calendar-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

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

let counter = 0;
async function createParentWithFamily() {
  counter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Annual Calendar Family ${counter}`)).id;
  const code = `annualcal${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Parent ${counter}`, code, code, familyId)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

test('Parent Portal: Annual Calendar is a read-only view, no click-to-color controls', async () => {
  const fy = await db.prepare('INSERT INTO fiscal_years (start_date, end_date) VALUES (?, ?) RETURNING *').get('2026-08-01', '2027-07-31');
  const calendar = await db.prepare('INSERT INTO annual_calendars (fiscal_year_id) VALUES (?) RETURNING *').get(fy.id);
  const key = await db.prepare("INSERT INTO annual_calendar_keys (calendar_id, label, color) VALUES (?, 'Holiday', '#aa00aa') RETURNING *").get(calendar.id);
  await db.prepare('INSERT INTO annual_calendar_days (calendar_id, day_date, key_id) VALUES (?, ?, ?)').run(calendar.id, '2026-12-25', key.id);

  const parent = await createParentWithFamily();
  const res = await request(app).get('/parent/annual-calendar').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Holiday/);
  assert.match(res.text, /August 2026/);
  assert.doesNotMatch(res.text, /data-annual-calendar-grid/, 'the parent view should not carry the click-to-color JS hooks');
  assert.doesNotMatch(res.text, /\+ Create Key/);
});

test('Parent Portal Forms card includes the Annual Calendar quick link', async () => {
  const parent = await createParentWithFamily();
  const res = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<li><a href="\/parent\/annual-calendar">Annual Calendar<\/a><\/li>/);
});
