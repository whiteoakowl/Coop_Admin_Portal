// A real request: "Add a tab in co-op admin portal settings called
// kiosk. There will be a drop down picker for choosing a semester that
// the kiosk page and all of its features are linked too. The floater
// list for that semester, the setup/cleanup, check in, check out...
// This way the kiosk can be changed each semester seamlessly." A
// follow-up confirmed each semester gets a fully separate Floater List
// and Setup/Cleanup Teams (new semester = blank slate), not a shared
// structure merely filtered by date range. Covers: the new Kiosk
// settings sub-tab itself, and that switching its semester actually
// isolates Floater Assignments, Setup/Cleanup, and Class Check-In data
// between semesters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `kiosk-semester-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `kiosk-semester-settings-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { getListByDay, addMemberToSection, sectionsForList } = require('../utils/volunteers');
const { getActiveKioskSemesterId, setActiveKioskSemesterId } = require('../utils/kioskSettings');

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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createSemester(cookie, csrfToken, title) {
  await request(app).post('/admin/schedule/semesters').set('Cookie', cookie).type('form').send({ title, _csrf: csrfToken });
  return (await db.prepare('SELECT * FROM semesters WHERE title = ?').get(title)).id;
}

test('Kiosk settings sub-tab shows a semester dropdown, and saving it updates the active semester', async () => {
  const admin = await loginAsAdmin();
  const fall = await createSemester(admin.cookie, admin.csrfToken, 'Fall 2026 Kiosk Test');
  const spring = await createSemester(admin.cookie, admin.csrfToken, 'Spring 2027 Kiosk Test');

  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=kiosk').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Active Kiosk Semester/);
  assert.match(page.text, /Fall 2026 Kiosk Test/);
  assert.match(page.text, /Spring 2027 Kiosk Test/);

  await request(app)
    .post('/admin/schedule/kiosk-semester')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ semesterId: String(fall), _csrf: admin.csrfToken });
  assert.equal(await getActiveKioskSemesterId(), fall);

  const afterFall = await request(app).get('/admin/schedule?tab=settings&settingsTab=kiosk').set('Cookie', admin.cookie);
  assert.match(afterFall.text, new RegExp(`<option value="${fall}" selected>`));

  await request(app)
    .post('/admin/schedule/kiosk-semester')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ semesterId: String(spring), _csrf: admin.csrfToken });
  assert.equal(await getActiveKioskSemesterId(), spring);
});

test('Posting the Kiosk semester form with no semester chosen is rejected with an error, not silently cleared', async () => {
  const admin = await loginAsAdmin();
  const fall = await createSemester(admin.cookie, admin.csrfToken, 'Fall 2026 Kiosk Guard');
  await setActiveKioskSemesterId(fall);

  const res = await request(app).post('/admin/schedule/kiosk-semester').set('Cookie', admin.cookie).type('form').send({ semesterId: '', _csrf: admin.csrfToken });
  assert.match(res.headers.location, /error=/);
  assert.equal(await getActiveKioskSemesterId(), fall, 'the previously active semester should be untouched');
});

test('Floater List: each semester gets its own fully separate list per day - adding a member under one semester never appears under another', async () => {
  const admin = await loginAsAdmin();
  const fall = await createSemester(admin.cookie, admin.csrfToken, 'Fall 2026 Floater Isolation');
  const spring = await createSemester(admin.cookie, admin.csrfToken, 'Spring 2027 Floater Isolation');

  const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Isolation Floater', 'isolation-floater', 'parent', 1)").run();
  const memberId = memberInfo.lastInsertRowid;

  await setActiveKioskSemesterId(fall);
  const fallList = await getListByDay('monday');
  assert.equal(fallList.semester_id, fall);
  const fallSections = await sectionsForList(fallList.id);
  await addMemberToSection(fallList.id, memberId, fallSections[0].id);

  await setActiveKioskSemesterId(spring);
  const springList = await getListByDay('monday');
  assert.notEqual(springList.id, fallList.id, 'Spring should get its own, different volunteer_lists row');
  assert.equal(springList.semester_id, spring);
  const springSections = await sectionsForList(springList.id);
  const springMembers = await db.prepare('SELECT * FROM volunteer_members WHERE volunteer_list_id = ?').all(springList.id);
  assert.equal(springMembers.length, 0, 'the Fall member should not carry over to Spring');
  assert.equal(springSections.length, 4, 'Spring should still get its own fresh 4 default Hour sections');

  // Switching back to Fall should resolve the SAME list again, member intact.
  await setActiveKioskSemesterId(fall);
  const fallAgain = await getListByDay('monday');
  assert.equal(fallAgain.id, fallList.id);
  const fallMembers = await db.prepare('SELECT * FROM volunteer_members WHERE volunteer_list_id = ?').all(fallList.id);
  assert.equal(fallMembers.length, 1);
});

test('Setup/Cleanup Teams: a team created under one semester is invisible under another', async () => {
  const admin = await loginAsAdmin();
  const fall = await createSemester(admin.cookie, admin.csrfToken, 'Fall 2026 Setup Isolation');
  const spring = await createSemester(admin.cookie, admin.csrfToken, 'Spring 2027 Setup Isolation');

  await setActiveKioskSemesterId(fall);
  await request(app)
    .post('/admin/setup/monday/teams')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall Cleanup Crew', _csrf: admin.csrfToken });

  const fallManage = await request(app).get('/admin/setup/monday/manage').set('Cookie', admin.cookie);
  assert.match(fallManage.text, /Fall Cleanup Crew/);

  await setActiveKioskSemesterId(spring);
  const springManage = await request(app).get('/admin/setup/monday/manage').set('Cookie', admin.cookie);
  assert.doesNotMatch(springManage.text, /Fall Cleanup Crew/, 'a Fall-only team must not leak into Spring');

  await setActiveKioskSemesterId(fall);
  const fallAgain = await request(app).get('/admin/setup/monday/manage').set('Cookie', admin.cookie);
  assert.match(fallAgain.text, /Fall Cleanup Crew/, 'switching back to Fall should still show its own team');
});

test('Class Check-In kiosk only lists/accepts classes from the active Kiosk semester', async () => {
  const admin = await loginAsAdmin();
  const fall = await createSemester(admin.cookie, admin.csrfToken, 'Fall 2026 Checkin Isolation');
  const spring = await createSemester(admin.cookie, admin.csrfToken, 'Spring 2027 Checkin Isolation');

  const fallClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Fall Only Class', semesterId: fall });
  await createClass({ day: 'monday', hourPosition: 2, className: 'Spring Only Class', semesterId: spring });

  await setActiveKioskSemesterId(fall);
  await request(app).post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
  const kioskCookie = (await request(app).post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' })).headers['set-cookie'];

  const fallList = await request(app).get('/kiosk/class-checkin/classes/monday').set('Cookie', kioskCookie);
  assert.match(fallList.text, /Fall Only Class/);
  assert.doesNotMatch(fallList.text, /Spring Only Class/);

  await setActiveKioskSemesterId(spring);
  const springList = await request(app).get('/kiosk/class-checkin/classes/monday').set('Cookie', kioskCookie);
  assert.doesNotMatch(springList.text, /Fall Only Class/);
  assert.match(springList.text, /Spring Only Class/);

  // A stale scan against the now-inactive Fall class is rejected rather
  // than silently checking a student into the wrong semester's roster.
  const scanRes = await request(app)
    .post(`/kiosk/class-checkin/classes/${fallClassId}/scan/checkin`)
    .set('Cookie', kioskCookie)
    .type('form')
    .send({ barcode: 'nonexistent-barcode' });
  assert.equal(scanRes.body.ok, false);
  assert.match(scanRes.body.message, /not part of the Kiosk's current semester/);
});
