// Coverage for two real requests:
// 1. "Parent dashboard, homepage, manage class registrations button goes
//    to the class schedule/registration page. When parents click on
//    class tab it should have the following subpages. Class
//    registration, Manage Classes, name tag request, absence/late form,
//    Policy Handbook. That manage class button on the parent portal
//    homepage should go to the manage classes page."
// 2. "Parent portal, click on class to register, the class card should
//    look like the image provided" - the class registration popup
//    (views/parent-class-fragment.ejs) redesign.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-classes-redesign-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-classes-redesign-test-uploads-${process.pid}`);
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
  const className = (overrides && overrides.className) || 'Redesign Test Class';
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
  // A real class needs registration open + parent-register allowed for
  // the fragment's own Register control to actually render.
  await db.prepare('UPDATE classes SET registration_open = 1, allow_parent_register = 1, allow_cancel = 1 WHERE id = ?').run(cls.id);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Redesign Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Redesign Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Redesign Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `redesign-parent${familyCounter}@example.com`;
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

test('Parent Portal homepage: "Manage Class Registration" links to /parent/classes/manage', async () => {
  const parent = await createParentWithChild();
  const home = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(home.text, /<a class="roster-action-btn" href="\/parent\/classes\/manage">Manage Class Registration<\/a>/);
});

test('Parent Portal: the Classes nav tab has all 6 subpages', async () => {
  const parent = await createParentWithChild();
  const home = await request(app).get('/parent').set('Cookie', parent.cookie);
  // A later real request ("Parent portal is not divided into sections.
  // Tabs are in this order... co-op classes...") renamed the nav label
  // from "Classes" to "Co-op Classes" (views/partials/portal-nav.ejs's
  // own PARENT_NAV_LINKS), which changes this dialog's auto-derived id
  // too (mobile-subpages-dialog.ejs slugifies the link's own label).
  const dialogMatch = /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-co-op-classes">([\s\S]*?)<\/dialog>/.exec(home.text);
  assert.ok(dialogMatch, 'expected a Co-op Classes subpages dialog');
  const dialog = dialogMatch[1];
  [
    ['/parent/classes', 'Class Registration'],
    ['/parent/classes/manage', 'View/Cancel Classes'],
    ['/parent/classes/dashboard', 'Class Dashboard'],
    ['/name-tag', 'Name Tag Form'],
    ['/absence', 'Absence/Late Form'],
    ['/parent/handbook', 'Policy Handbook'],
  ].forEach(([href, label]) => {
    assert.match(dialog, new RegExp(`class="view-tab" href="${href.replace('/', '\\/')}">${label}<`));
  });
});

test('View/Cancel Classes page: shows an enrolled child\'s class with a Cancel button, and cancelling (non-fetch) redirects back to it', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Manage Page Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const manage = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /Manage Page Class/);
  assert.match(manage.text, /Registered/);
  assert.match(manage.text, new RegExp(`data-cancel-class-url="/parent/classes/${cls.id}/unregister"`));

  const csrf2 = extractCsrf(manage.text);
  const cancelRes = await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', returnTo: 'manage', _csrf: csrf2 });
  assert.match(cancelRes.headers.location, /^\/parent\/classes\/manage\?/);

  const afterCancel = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  assert.match(afterCancel.text, /No one in your family is registered for a class yet/);
});

test('Policy Handbook page renders the admin-edited handbook content', async () => {
  const parent = await createParentWithChild();
  const emptyPage = await request(app).get('/parent/handbook').set('Cookie', parent.cookie);
  assert.equal(emptyPage.status, 200);
  assert.match(emptyPage.text, /hasn't been published yet/);

  const { setHandbookHtml } = require('../utils/membershipHandbook');
  await setHandbookHtml('<p>Be kind. Show up on time.</p>');

  const page = await request(app).get('/parent/handbook').set('Cookie', parent.cookie);
  assert.match(page.text, /Be kind\. Show up on time\./);
});

test('Class registration popup: redesigned card shows icon header, Day & Time/Location, Teacher/Assistant box, and a dark-blue Register button', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Card Redesign Class' });
  const staffCode = await generateMemberCode();
  const teacherInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)")
    .run('Sandrine Powell', staffCode, staffCode);
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(cls.id, teacherInfo.lastInsertRowid);

  const parent = await createParentWithChild();
  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  assert.equal(fragment.status, 200);

  assert.match(fragment.text, /class-view-icon-badge/);
  assert.match(fragment.text, /Class Registration<\/span>/);
  assert.match(fragment.text, /Day &amp; Time<\/span>/);
  assert.match(fragment.text, /Location<\/span>/);
  assert.match(fragment.text, /class-view-people-box/);
  assert.match(fragment.text, /Teacher<\/span>/);
  assert.match(fragment.text, /Sandrine Powell/);
  assert.match(fragment.text, /Grade Level<\/span>|Enrollment<\/span>/);
  assert.match(fragment.text, /class-view-register-box/);
  assert.match(fragment.text, /Register your children/);
  assert.match(fragment.text, /<button type="submit" class="primary-btn primary-btn-dark">Register<\/button>/);
});

test('Class registration popup: shows student/assistant signup counts (with slot totals) and a waitlist count', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Counts Class', capacity: '2' });
  await db.prepare('UPDATE classes SET assistant_slots = 1 WHERE id = ?').run(cls.id);

  const assistantCode = await generateMemberCode();
  const assistantInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)")
    .run('Nadia Ferris', assistantCode, assistantCode);
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'assistant')").run(cls.id, assistantInfo.lastInsertRowid);

  const parentA = await createParentWithChild();
  const parentB = await createParentWithChild();
  const parentC = await createParentWithChild();
  await request(app).post(`/parent/classes/${cls.id}/register`).set('Cookie', parentA.cookie).type('form').send({ studentId: String(parentA.childId), day: 'monday', _csrf: parentA.csrfToken });
  await request(app).post(`/parent/classes/${cls.id}/register`).set('Cookie', parentB.cookie).type('form').send({ studentId: String(parentB.childId), day: 'monday', _csrf: parentB.csrfToken });
  // Class is now full (capacity 2) - this third registration waitlists.
  await request(app).post(`/parent/classes/${cls.id}/register`).set('Cookie', parentC.cookie).type('form').send({ studentId: String(parentC.childId), day: 'monday', _csrf: parentC.csrfToken });

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parentA.cookie);
  assert.equal(fragment.status, 200);
  assert.match(fragment.text, /Students<\/span>\s*<strong class="class-view-info-value">2 \/ 2 signed up<\/strong>/);
  assert.match(fragment.text, /Assistants<\/span>\s*<strong class="class-view-info-value">1 \/ 1 signed up<\/strong>/);
  assert.match(fragment.text, /Waitlist<\/span>\s*<strong class="class-view-info-value">1 waiting<\/strong>/);
});
