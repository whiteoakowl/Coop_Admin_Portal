// A real request: "co-op admin portal, classes, grade selection and age
// selection should be separate menus of choices." classes.age_group
// stays the Grade list (unchanged); a new classes.numeric_ages column
// holds an independent list of exact ages (0-100, same shape utils/
// events.js's own age restriction already uses). Both gates only
// restrict when non-empty, and both must pass (mirrors events' own
// independent ageGroupAllowsMember/ageBucketAllowsMember pair).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-grade-age-menus-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-grade-age-menus-test-uploads-${process.pid}`);
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
const { todayISO } = require('../utils/dates');

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

let classCounter = 0;
async function createClass(admin, overrides) {
  classCounter += 1;
  const className = (overrides && overrides.className) || `Grade Age Test Class ${classCounter}`;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      className,
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      allowParentRegister: '1',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await db.prepare('UPDATE classes SET registration_open = 1, allow_parent_register = 1 WHERE id = ?').run(cls.id);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

let familyCounter = 0;
async function createParentWithChild(childBirthday) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Grade Age Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Grade Age Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, birthday) VALUES (?, ?, ?, 'student', ?, 1, ?)")
    .run(`Grade Age Child ${familyCounter}`, childCode, childCode, familyId, childBirthday || null);
  const email = `grade-age-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text), childId: childInfo.lastInsertRowid };
}

function birthdayForAge(age) {
  const [y, m, d] = todayISO().split('-').map(Number);
  return `${y - age}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

test('Class Details form: Grade and Age are two separate multi-select menus', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Menus Class' });
  const page = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<label class="roster-checkbox-label">Grade <span class="hint">/);
  assert.match(page.text, /<label class="roster-checkbox-label">Age <span class="hint">/);
  assert.match(page.text, /name="numericAges"/);
  assert.doesNotMatch(page.text, /Grade\/Age Group/);
});

test('Saving a class with only an Age selection does not require a Grade, and vice versa', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Age Only Class' });
  const editPage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(editPage.text);

  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: cls.class_name, hourPosition: '1', numericAges: ['5', '6'], _csrf: csrf });

  const updated = await db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
  assert.equal(updated.numeric_ages, '5, 6');
  assert.equal(updated.age_group, null);
});

test('A class restricted by Age only blocks a child outside that age, independent of grade', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Age Gate Class' });
  const editPage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(editPage.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: cls.class_name, hourPosition: '1', numericAges: ['7'], lockByAge: '1', _csrf: csrf });

  const tooOld = await createParentWithChild(birthdayForAge(10));
  const blocked = await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', tooOld.cookie)
    .type('form')
    .send({ studentId: String(tooOld.childId), day: 'monday', _csrf: tooOld.csrfToken });
  assert.match(decodeURIComponent(blocked.headers.location), /isn't an eligible age for this class/);

  const rightAge = await createParentWithChild(birthdayForAge(7));
  const allowed = await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', rightAge.cookie)
    .type('form')
    .send({ studentId: String(rightAge.childId), day: 'monday', _csrf: rightAge.csrfToken });
  assert.match(allowed.headers.location, /notice=/);
});
