// Coverage for the four filter dimensions a real request added to every
// portal's own Filter dialog: "member name dropdown. family dropdown.
// section dropdown with check boxes. portal dropdown with check boxes.
// registered for classes blank, yes, no." Scoped here to the Main Admin
// Members page's own Filter (views/partials/members-type-filter.ejs,
// routes/main-admin-members.js's own GET / query handling) - the
// existing Type/Family coverage lives in routes-main-admin-members-
// filter-popup.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-filter-fields-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-filter-fields-test-uploads-${process.pid}`);
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
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

function rowLinkFor(name) {
  return new RegExp(`class="member-row-name-link" href="[^"]+">${name}<`);
}

test('the Filter dialog lists a Member Name select, a Section checkbox group, a Portal checkbox group, and a Registered radio group', async () => {
  const cookie = await loginAsMainAdmin();
  await db.prepare("INSERT INTO sections (name) VALUES ('Filter Field Section')").run();
  // The Member Name <select> (views/partials/members-type-filter.ejs's
  // own msAllMemberNames.length > 0 guard) only renders once at least
  // one member exists - a fresh test DB otherwise has none yet.
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Filter Dialog Smoke Family') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Filter Dialog Smoke Member', 'filter-dialog-smoke-member', 'student', ?)").run(familyId);

  const res = await request(app).get('/main-admin/members?tab=members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /id="members-filter-member-select"/);
  assert.match(res.text, /Filter Field Section/);
  assert.match(res.text, /checkbox-group-label">Portal</);
  assert.match(res.text, /Registered for Classes: Any/);
});

test('memberId filters the roster down to exactly that one member', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('MemberId Filter Family') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('MemberId Target', 'memberid-target', 'student', ?)").run(familyId);
  const other = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('MemberId Other', 'memberid-other', 'student', ?) RETURNING id").get(familyId);
  const target = await db.prepare("SELECT id FROM members WHERE name = 'MemberId Target'").get();

  const res = await request(app).get(`/main-admin/members?tab=members&memberId=${target.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, rowLinkFor('MemberId Target'));
  assert.doesNotMatch(res.text, rowLinkFor('MemberId Other'));
  void other;
});

test('sectionIds filters the roster to members in that section', async () => {
  const cookie = await loginAsMainAdmin();
  const section = await db.prepare("INSERT INTO sections (name) VALUES ('Roster Section Filter Test') RETURNING id").get();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Section Filter Family') RETURNING id").get()).id;
  const inSection = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('In Section Member', 'in-section-member', 'student', ?) RETURNING id").get(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Out Of Section Member', 'out-of-section-member', 'student', ?)").run(familyId);
  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(inSection.id, section.id);

  const res = await request(app).get(`/main-admin/members?tab=members&sectionIds=${section.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, rowLinkFor('In Section Member'));
  assert.doesNotMatch(res.text, rowLinkFor('Out Of Section Member'));
});

test('registered=yes/no filters the roster by whether a student has any class enrollment on file', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Registered Filter Family') RETURNING id").get()).id;
  const enrolled = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Enrolled Student', 'enrolled-student', 'student', ?) RETURNING id").get(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Unenrolled Student', 'unenrolled-student', 'student', ?)").run(familyId);
  const cls = await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Registered Filter Class') RETURNING id").get();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, enrolled.id);

  const yesRes = await request(app).get('/main-admin/members?tab=members&registered=yes').set('Cookie', cookie);
  assert.equal(yesRes.status, 200);
  assert.match(yesRes.text, rowLinkFor('Enrolled Student'));
  assert.doesNotMatch(yesRes.text, rowLinkFor('Unenrolled Student'));

  const noRes = await request(app).get('/main-admin/members?tab=members&registered=no').set('Cookie', cookie);
  assert.equal(noRes.status, 200);
  assert.match(noRes.text, rowLinkFor('Unenrolled Student'));
  assert.doesNotMatch(noRes.text, rowLinkFor('Enrolled Student'));
});
