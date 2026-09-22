// Coverage for a real request: "Co-op admin portal. Add an orientation
// tab. List of members registered for classes on either day. Columns,
// member name, day Monday/Wednesday, orientation video, orientation meet
// up, teacher training and tour. The last four are circle check boxes
// that show green when complete. When they check in for the tour, check
// in for orientation meet up, complete the parent orientation video and
// teacher orientation video. Percentage to complete at the end of the
// row. Subpages, tour check in, orientation check in. Check in pages
// look like class check in. Shows everyone register for classes on
// either day on one list. Check in purple button at the top. Copy link
// button for direct link to that check in page."
//
// Later rebuilt semester-scoped - a real request: "Now each orientation
// semester is created with all members registered for classes that
// semester. Members are only listed once with arrow dropdown for
// children to expand and close. If member is signed up for Monday and
// Wednesday it will show both in the same column. Add button for
// orientation settings to Link training or check in with each circle
// check mark column so the information can be linked. Add a column for
// date completed."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-orientation-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-orientation-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/orientation').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createFamilyWithEnrolledStudent(day, overrides) {
  familyCounter += 1;
  const familyName = (overrides && overrides.familyName) || `Orientation Family ${familyCounter}`;
  const parentName = (overrides && overrides.parentName) || `Orientation Parent ${familyCounter}`;
  const semesterId = overrides && overrides.semesterId;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(familyName)).id;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(parentName, `orientation-parent-${familyCounter}`, familyId)
  ).id;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'student', ?, 1) RETURNING id")
      .get(`Orientation Student ${familyCounter}`, `orientation-student-${familyCounter}`, familyId)
  ).id;
  const classId = (
    await db
      .prepare('INSERT INTO classes (class_name, day, hour_position, semester_id) VALUES (?, ?, 1, ?) RETURNING id')
      .get(`Orientation Class ${familyCounter}`, day, semesterId || null)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
  return { familyId, parentId, studentId, classId };
}

test('Co-op Admin nav: Orientation item with Tour Check-In / Orientation Check-In subpages', async () => {
  const admin = await loginAsAdmin();
  const navPage = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(navPage.text, /href="\/admin\/orientation"/);
  assert.match(navPage.text, /href="\/admin\/orientation\/tour-checkin"/);
  assert.match(navPage.text, /href="\/admin\/orientation\/orientation-checkin"/);
});

test('Orientation list: one row per family (deduped across siblings), with a working percent-complete toggle', async () => {
  const admin = await loginAsAdmin();
  const { parentId, classId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'Dedup Test Parent' });

  // A second sibling enrolled in a DIFFERENT Monday class for the same family - should not add a second row.
  const sibling = (
    await db
      .prepare("SELECT family_id FROM members WHERE id = (SELECT student_id FROM class_enrollments WHERE class_id = ?)")
      .get(classId)
  ).family_id;
  const secondClassId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Dedup Second Class', 'monday', 2) RETURNING id").get()).id;
  const secondStudentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Dedup Sibling', 'dedup-sibling', 'student', ?, 1) RETURNING id")
      .get(sibling)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(secondClassId, secondStudentId);

  const page = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  // The name also appears inside each of the 5 circles' own aria-label,
  // so count table ROWS (roster-name-col cells), not raw name occurrences.
  const nameCellOccurrences = page.text.split('class="roster-name-col">Dedup Test Parent').length - 1;
  assert.equal(nameCellOccurrences, 1, 'the family should appear exactly once, not once per enrolled sibling');
  // Both siblings are enrolled, so an expand arrow for children should exist.
  assert.match(page.text, /data-orientation-expand/);
  assert.match(page.text, />0%</);

  const toggleOn = await request(app)
    .post(`/admin/orientation/${parentId}/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'video', value: '1' });
  assert.equal(toggleOn.status, 200);
  const afterOn = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  // 1 of 5 fields complete now that Open House is a 5th column (a real
  // request: "add a column for open house").
  assert.match(afterOn.text, />20%</);

  const toggleOff = await request(app)
    .post(`/admin/orientation/${parentId}/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'video', value: '0' });
  assert.equal(toggleOff.status, 200);
  const afterOff = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(afterOff.text, />0%</);
});

// A real request: "If member is signed up for Monday and Wednesday it
// will show both in the same column" - one row, not two, with a
// combined Day cell.
test('A family enrolled in both Monday and Wednesday classes gets one row with a combined Day column', async () => {
  const admin = await loginAsAdmin();
  const { parentId, familyId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'Both Days Parent' });
  const wedClassId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Both Days Wed Class', 'wednesday', 1) RETURNING id").get()).id;
  const wedStudentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Both Days Student', 'both-days-student', 'student', ?, 1) RETURNING id")
      .get(familyId)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(wedClassId, wedStudentId);

  const page = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  const nameCellOccurrences = page.text.split('class="roster-name-col">Both Days Parent').length - 1;
  assert.equal(nameCellOccurrences, 1, 'one row combining both days, not two');
  assert.match(page.text, />Monday, Wednesday</);
  void parentId;
});

test('Orientation toggle rejects an unknown field rather than interpolating it', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday');

  const badField = await request(app)
    .post(`/admin/orientation/${parentId}/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'drop table members', value: '1' });
  assert.equal(badField.status, 400);
});

test('Tour Check-In subpage: purple Check In button, Copy Link, shows every registered member, and bulk check-in marks tour complete', async () => {
  const admin = await loginAsAdmin();
  const monday = await createFamilyWithEnrolledStudent('monday', { parentName: 'Tour Monday Parent' });
  const wednesday = await createFamilyWithEnrolledStudent('wednesday', { parentName: 'Tour Wednesday Parent' });

  const page = await request(app).get('/admin/orientation/tour-checkin').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="class-checkin-btn"/);
  assert.match(page.text, /data-copy-link="[^"]*\/admin\/orientation\/tour-checkin"/);
  assert.match(page.text, /Tour Monday Parent/);
  assert.match(page.text, /Tour Wednesday Parent/);

  const csrf = extractCsrf(page.text);
  const checkin = await request(app)
    .post('/admin/orientation/tour-checkin')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, semesterId: '', members: [`${monday.parentId}`] });
  assert.equal(checkin.status, 302);
  assert.match(checkin.headers.location, /notice=Checked%20in%201%20member/);

  const row = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ?').get(monday.parentId);
  assert.equal(Number(row.tour_complete), 1);
  const wednesdayRow = await db.prepare('SELECT id FROM orientation_progress WHERE member_id = ?').get(wednesday.parentId);
  assert.equal(wednesdayRow, undefined, 'checking in the Monday family must not touch the Wednesday family');

  const afterPage = await request(app).get('/admin/orientation/tour-checkin').set('Cookie', admin.cookie);
  assert.match(afterPage.text, /Checked In/);
});

// A real request: "Orientation video column should say parent
// orientation, teacher training should say teacher orientation, add a
// column for open house. If the column title has two words stack them
// one on top of the other to save room." Plus the later "Add a column
// for date completed."
test('Orientation list: relabeled columns, a new Open House toggle, a Date Completed column, and two-word headers stacked with <br>', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'Relabel Test Parent' });

  const page = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<th class="orientation-col-center">\s*Parent<br>Orientation\s*<\/th>/);
  assert.match(page.text, /<th class="orientation-col-center">\s*Teacher<br>Orientation\s*<\/th>/);
  assert.match(page.text, /<th class="orientation-col-center">\s*Open<br>House\s*<\/th>/);
  assert.match(page.text, /<th class="orientation-col-center">%<br>Complete<\/th>/);
  assert.match(page.text, /<th class="orientation-col-center">Date<br>Completed<\/th>/);
  // "Orientation Meet Up" is 3 words, so it must NOT be stacked.
  assert.match(page.text, /Orientation Meet Up/);
  assert.doesNotMatch(page.text, />Orientation Video</);
  assert.doesNotMatch(page.text, />Teacher Training</);

  const toggleOn = await request(app)
    .post(`/admin/orientation/${parentId}/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'openHouse', value: '1' });
  assert.equal(toggleOn.status, 200);

  const row = await db.prepare('SELECT open_house_complete FROM orientation_progress WHERE member_id = ?').get(parentId);
  assert.equal(Number(row.open_house_complete), 1);

  const afterOn = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(afterOn.text, />20%</);
  assert.match(afterOn.text, /data-field="openHouse"\s+data-complete="1"/);
  // Not every field is complete yet, so Date Completed stays blank.
  assert.match(afterOn.text, /20%<\/td>\s*<td>—<\/td>/);
});

test('Date Completed shows the latest completion date once every circle is checked', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'All Done Parent' });
  const { FIELDS } = require('../utils/orientation');
  for (const field of FIELDS) {
    await request(app)
      .post(`/admin/orientation/${parentId}/toggle`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: admin.csrfToken, field, value: '1' });
  }
  const page = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(page.text, />100%<\/td>\s*<td>\d{4}-\d{2}-\d{2}/);
});

test('Orientation Check-In subpage marks meetup_complete, independently of the Tour Check-In page', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'Meetup Parent' });

  const page = await request(app).get('/admin/orientation/orientation-checkin').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="class-checkin-btn"/);
  assert.match(page.text, /data-copy-link="[^"]*\/admin\/orientation\/orientation-checkin"/);
  const csrf = extractCsrf(page.text);

  const checkin = await request(app)
    .post('/admin/orientation/orientation-checkin')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, semesterId: '', members: [`${parentId}`] });
  assert.equal(checkin.status, 302);

  const row = await db.prepare('SELECT meetup_complete, tour_complete FROM orientation_progress WHERE member_id = ?').get(parentId);
  assert.equal(Number(row.meetup_complete), 1);
  assert.equal(Number(row.tour_complete), 0);
});

// A real request: "Orientation gets a dropdown to pick which semester...
// Each semester's orientation view is built from every member
// registered for classes that semester."
test('Semester dropdown scopes the list to only classes assigned to that semester', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall Orientation Semester', _csrf: admin.csrfToken });
  const fall = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Fall Orientation Semester');
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Spring Orientation Semester', _csrf: admin.csrfToken });
  const spring = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Spring Orientation Semester');

  await createFamilyWithEnrolledStudent('monday', { parentName: 'Fall Only Parent', semesterId: fall.id });
  await createFamilyWithEnrolledStudent('monday', { parentName: 'Spring Only Parent', semesterId: spring.id });

  const fallPage = await request(app).get(`/admin/orientation?semesterId=${fall.id}`).set('Cookie', admin.cookie);
  assert.match(fallPage.text, /Fall Only Parent/);
  assert.doesNotMatch(fallPage.text, /Spring Only Parent/);

  const springPage = await request(app).get(`/admin/orientation?semesterId=${spring.id}`).set('Cookie', admin.cookie);
  assert.match(springPage.text, /Spring Only Parent/);
  assert.doesNotMatch(springPage.text, /Fall Only Parent/);

  // Defaults to the most-recently-created semester when none is specified.
  const defaultPage = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(defaultPage.text, /Spring Only Parent/);
  assert.doesNotMatch(defaultPage.text, /Fall Only Parent/);

  // Toggling a circle for the Fall family only affects that semester's own progress row.
  const fallParent = await db.prepare("SELECT id FROM members WHERE name = 'Fall Only Parent'").get();
  await request(app)
    .post(`/admin/orientation/${fallParent.id}/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'tour', value: '1', semesterId: String(fall.id) });
  const progressRow = await db.prepare('SELECT semester_id, tour_complete FROM orientation_progress WHERE member_id = ?').get(fallParent.id);
  assert.equal(progressRow.semester_id, fall.id);
  assert.equal(Number(progressRow.tour_complete), 1);
});

// A real request: "Add button for orientation settings to Link training
// or check in with each circle check mark column so the information can
// be linked."
test('Orientation Settings: saving a link makes that column header a hyperlink on the main list', async () => {
  const admin = await loginAsAdmin();
  await createFamilyWithEnrolledStudent('monday', { parentName: 'Link Header Parent' });

  const settingsPage = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.equal(settingsPage.status, 200);
  const csrf = extractCsrf(settingsPage.text);

  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, video: 'https://example.com/parent-orientation-video', meetup: '', teacherTraining: '', tour: '', openHouse: '' });

  const listPage = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(listPage.text, /<a href="https:\/\/example\.com\/parent-orientation-video" target="_blank" rel="noopener">\s*Parent<br>Orientation\s*<\/a>/);

  // Clearing the field removes the link again.
  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, video: '', meetup: '', teacherTraining: '', tour: '', openHouse: '' });
  const afterClear = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.doesNotMatch(afterClear.text, /<a href="https:\/\/example\.com\/parent-orientation-video"/);
});
