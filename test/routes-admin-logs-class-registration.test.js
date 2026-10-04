// A real request: "Co-op admin portal. Under logs tab add a class
// registration tab organized chart by day and family, families grouped
// together under a particular date." Mirrors the Absence Log's own
// family-then-date accordion (routes/admin-logs.js's own
// groupAbsenceSubmissionsByFamilyAndDate, reused as-is) - one row per
// class_registrations entry (not class_enrollments, which would drop a
// since-cancelled registration from the log), grouped by family and the
// calendar date the registration action happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-logs-class-registration-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-logs-class-registration-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createParentWithChild(familyName) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`${familyName} Parent`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`${familyName} Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `${familyName.toLowerCase().replace(/\s+/g, '-')}-${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text), childId: childInfo.lastInsertRowid, childName: `${familyName} Child ${familyCounter}` };
}

async function createOpenClass(admin, overrides) {
  const className = overrides.className;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'monday', className, hourPosition: '1', room: 'Room A', color: '#EE9A4D', _csrf: admin.csrfToken, ...overrides });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await db.prepare('UPDATE classes SET registration_open = 1 WHERE id = ?').run(cls.id);
  return cls;
}

test('Logs > Class Registration lists real registrations grouped by family and date, with class/day detail and a status badge', async () => {
  const admin = await loginAsAdmin();
  const cls = await createOpenClass(admin, { className: 'Logs Test Pottery' });

  const family = await createParentWithChild('Logreg Family');
  const reg = await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ studentId: String(family.childId), day: 'monday', _csrf: family.csrfToken });
  assert.match(reg.headers.location, /notice=/);

  const page = await request(app).get('/admin/logs?tab=classregistration').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Logreg Family/);
  assert.match(page.text, /Logs Test Pottery/);
  assert.match(page.text, />Monday</);
  assert.match(page.text, /Confirmed/);
  assert.match(page.text, new RegExp(family.childName));

  // The nav lists it as its own Logs subpage.
  assert.match(page.text, /Class Registration Log/);
});

test('cancelling a registration keeps it in the log (never deleted) with a Cancelled status, unlike class_enrollments', async () => {
  const admin = await loginAsAdmin();
  const cls = await createOpenClass(admin, { className: 'Logs Test Robotics' });
  const family = await createParentWithChild('Cancelreg Family');

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ studentId: String(family.childId), day: 'monday', _csrf: family.csrfToken });

  await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ studentId: String(family.childId), day: 'monday', _csrf: family.csrfToken });

  const enrollment = await db.prepare('SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, family.childId);
  assert.equal(enrollment, undefined, 'the enrollment row is gone');

  const page = await request(app).get('/admin/logs?tab=classregistration').set('Cookie', admin.cookie);
  assert.match(page.text, /Cancelreg Family/, 'the cancelled registration should still show up in the log');
  assert.match(page.text, /Cancelled/);
});

test('the date filter narrows the list to just that day, and the CSV export carries the same columns', async () => {
  const admin = await loginAsAdmin();
  const cls = await createOpenClass(admin, { className: 'Logs Test Art' });
  const family = await createParentWithChild('Datefilter Family');

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ studentId: String(family.childId), day: 'monday', _csrf: family.csrfToken });

  const today = (await db.prepare('SELECT now_text() AS now').get()).now.slice(0, 10);

  const wrongDate = await request(app).get('/admin/logs?tab=classregistration&date=2020-01-01').set('Cookie', admin.cookie);
  assert.doesNotMatch(wrongDate.text, /Datefilter Family/);

  const rightDate = await request(app).get(`/admin/logs?tab=classregistration&date=${today}`).set('Cookie', admin.cookie);
  assert.match(rightDate.text, /Datefilter Family/);

  const csv = await request(app).get('/admin/logs/classregistration/export.csv').set('Cookie', admin.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Name.*Class.*Day.*Date.*Status/);
  assert.match(csv.text, /Logs Test Art/);
});
