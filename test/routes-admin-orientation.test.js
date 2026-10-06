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

test('Co-op Admin nav: Orientation item with Tour Check-In / Open House Check-In subpages', async () => {
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
  // 1 of 4 fields complete (video, teacherTraining, tour, openHouse - the
  // Meet Up column was removed per a real request: "Delete orientation
  // Meet-up column").
  assert.match(afterOn.text, />25%</);

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

test('Tour Check-In subpage: purple Check In link to the scan screen, Copy Link, and only Check In/Day columns', async () => {
  const admin = await loginAsAdmin();
  const monday = await createFamilyWithEnrolledStudent('monday', { parentName: 'Tour Monday Parent' });

  const page = await request(app).get('/admin/orientation/tour-checkin').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a href="\/admin\/orientation\/tour-checkin\/scan[^"]*" class="class-checkin-btn">Check In<\/a>/);
  assert.match(page.text, /data-copy-link="[^"]*\/admin\/orientation\/tour-checkin"/);
  assert.match(page.text, /Tour Monday Parent/);
  // A real request: "only 1 column for check in and one for day" - no
  // more Select All/checkbox column, no separate Status column.
  assert.match(page.text, /<th>Check In<\/th>\s*<th>Day<\/th>/);
  assert.doesNotMatch(page.text, /data-select-all-for/);
  void monday;
});

// A real request: "click check in button should have same card screen as
// kiosk with mobile scan, barcode scan or enter ID button choices. All
// three options should allow for continuous scan/entry with a complete
// button for when ready to return to the tour check in or open house
// check in screens."
test('Tour Check-In scan screen: method chooser, Complete buttons, and scanning a barcode marks tour complete', async () => {
  const admin = await loginAsAdmin();
  const monday = await createFamilyWithEnrolledStudent('monday', { parentName: 'Scan Tour Parent' });

  const scanPage = await request(app).get('/admin/orientation/tour-checkin/scan').set('Cookie', admin.cookie);
  assert.equal(scanPage.status, 200);
  assert.match(scanPage.text, /data-method="mobile-scan"/);
  assert.match(scanPage.text, /data-method="scanner"/);
  assert.match(scanPage.text, /data-method="manual"/);
  assert.match(scanPage.text, /data-complete-url="\/admin\/orientation\/tour-checkin/);
  // Every one of the 3 method panels gets its own Complete button.
  const completeButtonCount = (scanPage.text.match(/data-complete>Complete<\/button>/g) || []).length;
  assert.equal(completeButtonCount, 3, 'mobile scan, barcode scan, and manual entry should each have their own Complete button');

  const parent = await db.prepare('SELECT barcode FROM members WHERE id = ?').get(monday.parentId);
  const scan = await request(app)
    .post('/admin/orientation/tour-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: parent.barcode, semesterId: '' });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.ok, true);
  assert.match(scan.body.message, /Scan Tour Parent/);

  const row = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ?').get(monday.parentId);
  assert.equal(Number(row.tour_complete), 1);

  // Scanning the same barcode again reports already-checked-in rather
  // than erroring or silently re-doing the same write.
  const scanAgain = await request(app)
    .post('/admin/orientation/tour-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: parent.barcode, semesterId: '' });
  assert.equal(scanAgain.body.ok, true);
  assert.equal(scanAgain.body.alreadyChecked, true);
});

// A real bug class already fixed once for Training completions
// (utils/orientation.js's own orientationObligationMemberId) - a scan
// check-in must credit the same risk here: whichever family member
// actually scans in, the green check has to land on the row Orientation
// Tracking actually shows for that family (the Primary Parent), not a
// separate row for whoever walked up to the scanner.
test('Tour Check-In scan: a non-primary parent scanning in still checks the family\'s PRIMARY parent row', async () => {
  const admin = await loginAsAdmin();
  const family = await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get('Scan Obligation Family');
  const primaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get('Scan Primary Parent', 'scan-primary-1', family.id)
  ).id;
  const secondParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 0, 1) RETURNING id")
      .get('Scan Second Parent', 'scan-second-1', family.id)
  ).id;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'student', ?, 1) RETURNING id")
      .get('Scan Obligation Student', 'scan-student-1', family.id)
  ).id;
  const classId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Scan Obligation Class', 'monday', 1) RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);

  const scan = await request(app)
    .post('/admin/orientation/tour-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: 'scan-second-1', semesterId: '' });
  assert.equal(scan.body.ok, true);

  const primaryRow = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ?').get(primaryParentId);
  assert.ok(primaryRow, 'the primary parent should have the orientation_progress row');
  assert.equal(Number(primaryRow.tour_complete), 1);
  const secondRow = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(secondParentId);
  assert.equal(secondRow, undefined, 'the member who actually scanned must not get their own separate row');
});

test('Tour Check-In scan rejects a barcode for someone not registered for classes this semester', async () => {
  const admin = await loginAsAdmin();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Unregistered Scan Member', 'unregistered-scan-1', 'parent', 1)").run();

  const scan = await request(app)
    .post('/admin/orientation/tour-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: 'unregistered-scan-1', semesterId: '' });
  assert.equal(scan.body.ok, false);
  assert.match(scan.body.message, /not registered for classes this semester/);
});

test('Tour Check-In scan: an unrecognized barcode reports Not recognized', async () => {
  const admin = await loginAsAdmin();
  const scan = await request(app)
    .post('/admin/orientation/tour-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: 'no-such-barcode-at-all', semesterId: '' });
  assert.equal(scan.body.ok, false);
  assert.match(scan.body.message, /Not recognized/);
});

// A real request: "orientation check in subpage and tour check in
// subpage, on mobile. Check in and copy link buttons should be on the
// same row, similar size but fit text nicely, and centered in mobile. On
// desktop check in buttons on the far left and copy link button on far
// right." public/css/styles.css's own .orientation-checkin-btn-row rules
// are what deliver that layout - this just locks in the markup contract
// those rules are scoped to, on both check-in subpages.
test('Tour Check-In and Open House Check-In toolbars carry the orientation-checkin-btn-row class their mobile/desktop layout CSS is scoped to', async () => {
  const admin = await loginAsAdmin();
  for (const url of ['/admin/orientation/tour-checkin', '/admin/orientation/orientation-checkin']) {
    const page = await request(app).get(url).set('Cookie', admin.cookie);
    assert.equal(page.status, 200, url);
    assert.match(page.text, /class="roster-btn-row orientation-checkin-btn-row"/, url);
  }
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
  // The Meet Up column was removed per a real request: "Delete
  // orientation Meet-up column".
  assert.doesNotMatch(page.text, /Orientation Meet Up/);
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
  // 1 of 4 fields complete now that Meet Up is gone (video, teacherTraining, tour, openHouse).
  assert.match(afterOn.text, />25%</);
  assert.match(afterOn.text, /data-field="openHouse"\s+data-complete="1"/);
  // Not every field is complete yet, so Date Completed stays blank.
  assert.match(afterOn.text, /25%<\/td>\s*<td>—<\/td>/);
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

// A real request: "Delete orientation Meet-up column", with "Orientation
// check in should be linked to open house column" - the subpage keeps
// its name but now checks in Open House instead of the removed Meet Up
// field.
test('Open House Check-In subpage scan marks open_house_complete, independently of the Tour Check-In page', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday', { parentName: 'Open House Checkin Parent' });

  const page = await request(app).get('/admin/orientation/orientation-checkin').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="class-checkin-btn"/);
  assert.match(page.text, /data-copy-link="[^"]*\/admin\/orientation\/orientation-checkin"/);

  const scanPage = await request(app).get('/admin/orientation/orientation-checkin/scan').set('Cookie', admin.cookie);
  assert.equal(scanPage.status, 200);

  const parent = await db.prepare('SELECT barcode FROM members WHERE id = ?').get(parentId);
  const checkin = await request(app)
    .post('/admin/orientation/orientation-checkin/scan')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: parent.barcode, semesterId: '' });
  assert.equal(checkin.body.ok, true);

  const row = await db.prepare('SELECT open_house_complete, tour_complete FROM orientation_progress WHERE member_id = ?').get(parentId);
  assert.equal(Number(row.open_house_complete), 1);
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

  // A real request: "tour check in and open house check in should have
  // semester dropdown switch like orientation tracking page" - same
  // dropdown, same two semesters.
  for (const url of ['/admin/orientation/tour-checkin', '/admin/orientation/orientation-checkin']) {
    const checkinPage = await request(app).get(url).set('Cookie', admin.cookie);
    assert.match(checkinPage.text, /id="orientation-checkin-semester-select"/, url);
    assert.match(checkinPage.text, /Fall Orientation Semester/, url);
    assert.match(checkinPage.text, /Spring Orientation Semester/, url);
  }
});

// A real request: "Add button for orientation settings to Link training
// or check in with each circle check mark column so the information can
// be linked."
test('Orientation Settings: linking a Training to a column makes that column header a hyperlink to it on the main list', async () => {
  const admin = await loginAsAdmin();
  await createFamilyWithEnrolledStudent('monday', { parentName: 'Link Header Parent' });

  const { createTraining } = require('../utils/training');
  const trainingId = await createTraining({ title: 'Parent Orientation Video', passingScore: 80 });

  const settingsPage = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.equal(settingsPage.status, 200);
  const csrf = extractCsrf(settingsPage.text);

  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, videoTrainingId: String(trainingId) });

  const listPage = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(listPage.text, new RegExp(`<a href="/admin/training/${trainingId}/builder">\\s*Parent<br>Orientation\\s*</a>`));

  // Clearing the dropdown removes the link again.
  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, videoTrainingId: '' });
  const afterClear = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.doesNotMatch(afterClear.text, new RegExp(`<a href="/admin/training/${trainingId}/builder"`));
});
