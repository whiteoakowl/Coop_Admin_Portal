// Coverage for a real request: "Parent portal, class registration, add
// icons at the top for grid view vs list view of classes like co-op
// class portal." The room/hour grid (views/parent-classes.ejs's
// original, now the `view=grid` default) stays as-is; `view=list`
// flattens the same day's classes into one time-sorted vertical stack
// instead (routes/parent-portal.js's own GET /classes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-classes-grid-list-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-classes-grid-list-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createClass(admin, overrides) {
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      room: 'Room A',
      color: '#EE9A4D',
      allowParentRegister: '1',
      _csrf: admin.csrfToken,
      ...overrides,
    });
}

let accountCounter = 0;
async function createParentAccount() {
  accountCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Grid List Family ${accountCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run('Grid List Parent', code, code, familyId);
  const email = `grid-list-parent-${accountCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return loginRes.headers['set-cookie'];
}

test('Parent Portal Class Registration: grid view (default) shows the room grid and a Grid-view-active toggle', async () => {
  const admin = await loginAsAdmin();
  await createClass(admin, { className: 'Grid Default Class', hourPosition: '1', startTime: '9:00 AM', endTime: '9:45 AM' });
  const cookie = await createParentAccount();

  const page = await request(app).get('/parent/classes?day=monday').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="icon-btn icon-btn-active" href="\/parent\/classes\?day=monday&view=grid"/);
  assert.match(page.text, /class="icon-btn" href="\/parent\/classes\?day=monday&view=list"/);
  assert.match(page.text, /class-schedule-room-grid/);
  assert.doesNotMatch(page.text, /class="parent-class-list"/);
});

test('Parent Portal Class Registration: list view flattens classes sorted by start time, List toggle active', async () => {
  const admin = await loginAsAdmin();
  await createClass(admin, { className: 'Afternoon Class', hourPosition: '2', startTime: '1:00 PM', endTime: '1:45 PM' });
  await createClass(admin, { className: 'Morning Class', hourPosition: '1', startTime: '9:00 AM', endTime: '9:45 AM' });
  const cookie = await createParentAccount();

  const page = await request(app).get('/parent/classes?day=monday&view=list').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="icon-btn icon-btn-active" href="\/parent\/classes\?day=monday&view=list"/);
  assert.match(page.text, /class="parent-class-list"/);
  assert.doesNotMatch(page.text, /class-schedule-room-grid/);

  const morningIdx = page.text.indexOf('Morning Class');
  const afternoonIdx = page.text.indexOf('Afternoon Class');
  assert.ok(morningIdx !== -1 && afternoonIdx !== -1, 'both classes should render');
  assert.ok(morningIdx < afternoonIdx, 'Morning Class (9am) should list before Afternoon Class (1pm)');
});

test('Parent Portal Class Registration: the day toggle preserves the current view', async () => {
  const admin = await loginAsAdmin();
  await createClass(admin, { className: 'Day Toggle Class', hourPosition: '1', startTime: '9:00 AM', endTime: '9:45 AM' });
  const cookie = await createParentAccount();

  const page = await request(app).get('/parent/classes?day=monday&view=list').set('Cookie', cookie);
  assert.match(page.text, /class="day-toggle-option active" href="\/parent\/classes\?day=monday&view=list"/);
});
