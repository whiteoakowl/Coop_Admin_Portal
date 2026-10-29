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
  // generic account-settings page. It also carries a ?portal=parent tag
  // (see portal-nav.ejs's own cornerPortalQuery comment) so a dual-role
  // account's Profile link stays on whichever portal it's viewing.
  assert.match(page.text, /class="admin-corner-link" href="\/portal\/profile\?portal=parent"/);
});

test('birthday and grade level are visible but locked - only an admin can change them', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  // A later real request changed the displayed birthday format to a
  // long "Month D, YYYY" label (see utils/dates.js's own
  // formatDateLongNoWeekday) - the stored value itself is still the
  // plain ISO date underneath, only the disabled input's own display
  // text changed.
  assert.match(page.text, /<input type="text" value="January 1, 1985" disabled \/>/);

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

// A later real request: "Schedules tab should be organized by family
// member and then by day under each family member."
test('Schedules tab is grouped by family member, then by day under each member', async () => {
  const parent = await createParentAccount();
  const mondayClass = await db
    .prepare("INSERT INTO classes (day, hour_position, class_name, room, start_time, end_time) VALUES ('monday', 1, 'Monday Art', 'Room 5', '9:00 AM', '10:00 AM')")
    .run();
  const wednesdayClass = await db
    .prepare("INSERT INTO classes (day, hour_position, class_name, room, start_time, end_time) VALUES ('wednesday', 1, 'Wednesday Science', 'Room 6', '11:00 AM', '12:00 PM')")
    .run();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(mondayClass.lastInsertRowid, parent.studentId);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(wednesdayClass.lastInsertRowid, parent.studentId);

  const page = await request(app).get('/portal/profile?tab=schedules').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  const kidIndex = page.text.indexOf('Profile Test Kid');
  const mondayIndex = page.text.indexOf('>Monday<');
  const mondayArtIndex = page.text.indexOf('Monday Art');
  const wednesdayIndex = page.text.indexOf('>Wednesday<');
  const wednesdayScienceIndex = page.text.indexOf('Wednesday Science');
  assert.ok(kidIndex !== -1 && mondayIndex !== -1 && mondayArtIndex !== -1 && wednesdayIndex !== -1 && wednesdayScienceIndex !== -1, 'the member heading and both day headings must be present');
  assert.ok(kidIndex < mondayIndex && mondayIndex < mondayArtIndex && mondayArtIndex < wednesdayIndex && wednesdayIndex < wednesdayScienceIndex, 'the member section must come before Monday, Monday before its class, Monday before Wednesday, and Wednesday before its own class');

  // The parent themselves has no enrollments/staff rows - their own
  // section still renders, just with the "no classes" fallback instead
  // of being silently dropped from the page.
  assert.match(page.text, /No classes scheduled\./);
});

// A later real request: "Event signup tab should be organized by month
// and then by event with drop down from the event to show who signed up
// and what you may have signed up for like food, volunteer etc."
test('Event Signups tab is grouped by month, then by event, with a dropdown showing registrations, food-item claims, and volunteer shift signups', async () => {
  const parent = await createParentAccount();
  const eventInfo = await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Fall Festival', '2026-10-15 10:00:00', 'published')")
    .run();
  const eventId = eventInfo.lastInsertRowid;
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, parent.memberId);

  const signUpListInfo = await db.prepare('INSERT INTO sign_up_lists (title, event_id) VALUES (?, ?)').run('Potluck', eventId);
  const itemInfo = await db.prepare('INSERT INTO sign_up_list_items (list_id, item_name, quantity_needed) VALUES (?, ?, ?)').run(signUpListInfo.lastInsertRowid, 'Cupcakes', 12);
  await db.prepare('INSERT INTO sign_up_list_claims (item_id, member_id, quantity_claimed) VALUES (?, ?, ?)').run(itemInfo.lastInsertRowid, parent.memberId, 2);

  const volunteerListInfo = await db.prepare('INSERT INTO volunteer_signup_lists (title, event_id) VALUES (?, ?)').run('Setup Crew', eventId);
  const shiftInfo = await db
    .prepare("INSERT INTO volunteer_signup_list_shifts (list_id, job_name, shift_date, start_time, end_time) VALUES (?, ?, '2026-10-15', '8:00 AM', '9:00 AM')")
    .run(volunteerListInfo.lastInsertRowid, 'Chair Setup');
  await db.prepare('INSERT INTO volunteer_signup_list_signups (shift_id, member_id) VALUES (?, ?)').run(shiftInfo.lastInsertRowid, parent.studentId);

  const page = await request(app).get('/portal/profile?tab=signups').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />October 2026</, 'the month section label');
  assert.match(page.text, /Fall Festival/);
  assert.match(page.text, /badge-pill-green">Confirmed</);
  assert.match(page.text, /Cupcakes/);
  assert.match(page.text, /x2/, 'the claimed quantity shows when more than 1');
  assert.match(page.text, /Chair Setup/);
  assert.match(page.text, /Profile Test Kid/, 'the student who signed up for the volunteer shift');

  // Scoped to this family only - another family's parent gets an empty
  // Event Signups tab even though the event itself exists globally.
  const otherParent = await createParentAccount();
  const otherPage = await request(app).get('/portal/profile?tab=signups').set('Cookie', otherParent.cookie);
  assert.doesNotMatch(otherPage.text, /Fall Festival/);
});

// A real request: "Below the family section it should show what
// sections and portals the member has permissions for."
test('My Profile shows the signed-in member\'s own Sections and Portal Roles below My Family', async () => {
  const parent = await createParentAccount();
  const sectionInfo = await db.prepare("INSERT INTO sections (name) VALUES ('Teen Co-op')").run();
  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(parent.memberId, sectionInfo.lastInsertRowid);

  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  const familyIndex = page.text.indexOf('>My Family<');
  const sectionsIndex = page.text.indexOf('>Sections<');
  const teenCoopIndex = page.text.indexOf('Teen Co-op');
  const portalRolesIndex = page.text.indexOf('>Portal Roles<');
  const parentRoleIndex = page.text.indexOf('<li>Parent</li>');
  assert.ok(familyIndex !== -1 && sectionsIndex !== -1 && teenCoopIndex !== -1 && portalRolesIndex !== -1 && parentRoleIndex !== -1, 'all four markers must be present');
  assert.ok(
    familyIndex < sectionsIndex && sectionsIndex < teenCoopIndex && teenCoopIndex < portalRolesIndex && portalRolesIndex < parentRoleIndex,
    'Sections/Portal Roles must render below My Family, each with its own data'
  );
});

// A real request: "Member profile. There should be a place for password
// settings for every parent and student" - a self-service Password tab
// on this same shared My Profile page, reachable by any portal account
// (parent, student, or otherwise) since it posts against req.portalAccount.
test('Password tab renders a current/new/confirm password form', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile?tab=password').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="view-tab active" href="\/portal\/profile\?tab=password">Password</);
  assert.match(page.text, /<input type="password" name="currentPassword"/);
  assert.match(page.text, /<input type="password" name="newPassword"/);
  assert.match(page.text, /<input type="password" name="confirmPassword"/);
});

test('changing the password with the correct current password succeeds and the new password logs in', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/password')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ currentPassword: 'testpassword123', newPassword: 'brandnewpassword456', confirmPassword: 'brandnewpassword456', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /tab=password/);
  assert.match(res.headers.location, /notice=/);

  const account = await db.prepare('SELECT member_id FROM member_accounts WHERE member_id = ?').get(parent.memberId);
  assert.ok(account, 'account still exists');

  const loginRes = await request(app).get('/portal/profile'); // sanity: unauthenticated still redirects
  assert.equal(loginRes.status, 302);

  const oldPasswordLogin = await request(app).post('/login').type('form').send({ email: `profile-test-parent-${familyCounter}@example.com`, password: 'testpassword123', next: '/portal/profile' });
  assert.match(oldPasswordLogin.text, /Incorrect email or password/, 'the old password no longer works');

  const newPasswordLogin = await request(app).post('/login').type('form').send({ email: `profile-test-parent-${familyCounter}@example.com`, password: 'brandnewpassword456', next: '/portal/profile' });
  assert.equal(newPasswordLogin.status, 302);
  assert.match(newPasswordLogin.headers.location, /\/portal\/profile/);
});

test('changing the password with the wrong current password fails and leaves the password unchanged', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/password')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ currentPassword: 'wrongpassword', newPassword: 'brandnewpassword456', confirmPassword: 'brandnewpassword456', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  assert.match(res.headers.location, /tab=password/);

  const stillWorks = await request(app).post('/login').type('form').send({ email: `profile-test-parent-${familyCounter}@example.com`, password: 'testpassword123', next: '/portal/profile' });
  assert.equal(stillWorks.status, 302, 'the original password still logs in');
});

test('changing the password with mismatched new/confirm fields fails with an error', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/password')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ currentPassword: 'testpassword123', newPassword: 'brandnewpassword456', confirmPassword: 'somethingelse789', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
});

test('changing the password to something under 8 characters fails with an error', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/password')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ currentPassword: 'testpassword123', newPassword: 'short', confirmPassword: 'short', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
});

test('signing out and hitting the profile page redirects to login', async () => {
  const res = await request(app).get('/portal/profile');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});
