// Real HTTP-level coverage for a real request: "Clicking on the profile
// icon at the top on every portal should be the member's full profile
// membership form so that they can edit it. They still can't edit the
// birthday and grade level after joining though. They can see it but
// it's locked. Only admin can change that on their form. It will also
// have a tab for schedules, event signups."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-profile-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Profile Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active, birthday, grade_level) VALUES (?, ?, ?, 'parent', ?, 1, 1, '1985-01-01', null)")
    .run(`Profile Test Parent ${familyCounter}`, code, code, familyId);
  const email = `profile-test-parent-${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, birthday, grade_level) VALUES (?, ?, ?, 'student', ?, 1, '2015-06-01', '3rd Grade')")
    .run(`Profile Test Kid ${familyCounter}`, await generateMemberCode(), code + '-kid', familyId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal/profile' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/portal/profile').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, studentId: studentInfo.lastInsertRowid };
}

test('a real request: "clicking the profile icon... should be the member\'s full profile membership form"', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /value="Profile Test Parent 1"/);

  // The profile icon in the shared nav shell now points here, not at the
  // generic account-settings page.
  assert.match(page.text, /class="admin-corner-link" href="\/portal\/profile"/);
});

test('birthday and grade level are visible but locked - only an admin can change them', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  assert.match(page.text, /1985-01-01/);
  assert.match(page.text, /<input type="text" value="1985-01-01" disabled \/>/);

  // A spoofed attempt to change them (or the name/type) through this
  // route has nothing to grab onto - the route never even reads a
  // birthday/gradeLevel/memberType field.
  await request(app)
    .post('/portal/profile')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Profile Test Parent', phone: '555-9999', birthday: '2000-01-01', gradeLevel: '5th Grade', memberType: 'admin', _csrf: parent.csrfToken });

  const member = await db.prepare('SELECT birthday, grade_level, phone, member_type FROM members WHERE id = ?').get(parent.memberId);
  assert.equal(member.birthday, '1985-01-01', 'birthday must never change through this route');
  assert.equal(member.grade_level, null);
  assert.equal(member.phone, '555-9999', 'ordinary contact fields still save normally');
  assert.equal(member.member_type, 'parent', 'member type can never be spoofed to admin through this route');
});

test('editing contact info through the profile form saves correctly', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Profile Test Parent', address: '123 Main St', city: 'Springfield', state: 'IL', zip: '62704', phone: '555-1212', email: 'updated@example.com', medicalNotes: 'No allergies', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(parent.memberId);
  assert.equal(member.address, '123 Main St');
  assert.equal(member.city, 'Springfield');
  assert.equal(member.phone, '555-1212');
  assert.equal(member.email, 'updated@example.com');
  assert.equal(member.medical_notes, 'No allergies');
});

test('Schedules tab lists the family\'s class enrollments', async () => {
  const parent = await createParentAccount();
  const classInfo = await db
    .prepare("INSERT INTO classes (day, hour_position, class_name, room, start_time, end_time) VALUES ('monday', 1, 'Art Class', 'Room 5', '9:00 AM', '10:00 AM')")
    .run();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classInfo.lastInsertRowid, parent.studentId);

  const page = await request(app).get('/portal/profile?tab=schedules').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Art Class/);
  assert.match(page.text, /Room 5/);
  assert.match(page.text, /Profile Test Kid/);
});

test('Event Signups tab lists the family\'s event registrations', async () => {
  const parent = await createParentAccount();
  const eventInfo = await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Fall Festival', '2026-10-15 10:00:00', 'published')")
    .run();
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventInfo.lastInsertRowid, parent.memberId);

  const page = await request(app).get('/portal/profile?tab=signups').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Fall Festival/);
  assert.match(page.text, /badge-pill-green">Confirmed</);
});

test('signing out and hitting the profile page redirects to login', async () => {
  const res = await request(app).get('/portal/profile');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});
