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
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES (?, ?, 1) RETURNING id").get(`Orientation Class ${familyCounter}`, day)
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

test('Orientation list: one row per family per day, deduped across siblings, with a working percent-complete toggle', async () => {
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
  // The name also appears inside each of the 4 circles' own aria-label,
  // so count table ROWS (roster-name-col cells), not raw name occurrences.
  const nameCellOccurrences = page.text.split('class="roster-name-col">Dedup Test Parent').length - 1;
  assert.equal(nameCellOccurrences, 1, 'the family should appear exactly once for Monday, not once per enrolled sibling');
  assert.match(page.text, />0%</);

  const toggleOn = await request(app)
    .post(`/admin/orientation/${parentId}/monday/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'video', value: '1' });
  assert.equal(toggleOn.status, 200);
  const afterOn = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(afterOn.text, />25%</);

  const toggleOff = await request(app)
    .post(`/admin/orientation/${parentId}/monday/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'video', value: '0' });
  assert.equal(toggleOff.status, 200);
  const afterOff = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.match(afterOff.text, />0%</);
});

test('Orientation toggle rejects an unknown field or day rather than interpolating it', async () => {
  const admin = await loginAsAdmin();
  const { parentId } = await createFamilyWithEnrolledStudent('monday');

  const badField = await request(app)
    .post(`/admin/orientation/${parentId}/monday/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'drop table members', value: '1' });
  assert.equal(badField.status, 400);

  const badDay = await request(app)
    .post(`/admin/orientation/${parentId}/friday/toggle`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field: 'video', value: '1' });
  assert.equal(badDay.status, 400);
});

test('Tour Check-In subpage: purple Check In button, Copy Link, shows every registered member from either day, and bulk check-in marks tour complete', async () => {
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
    .send({ _csrf: csrf, members: [`${monday.parentId}:monday`] });
  assert.equal(checkin.status, 302);
  assert.match(checkin.headers.location, /notice=Checked%20in%201%20member/);

  const row = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ? AND day = ?').get(monday.parentId, 'monday');
  assert.equal(Number(row.tour_complete), 1);
  const wednesdayRow = await db.prepare('SELECT id FROM orientation_progress WHERE member_id = ? AND day = ?').get(wednesday.parentId, 'wednesday');
  assert.equal(wednesdayRow, undefined, 'checking in the Monday family must not touch the Wednesday family');

  const afterPage = await request(app).get('/admin/orientation/tour-checkin').set('Cookie', admin.cookie);
  assert.match(afterPage.text, /Checked In/);
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
    .send({ _csrf: csrf, members: [`${parentId}:monday`] });
  assert.equal(checkin.status, 302);

  const row = await db.prepare('SELECT meetup_complete, tour_complete FROM orientation_progress WHERE member_id = ? AND day = ?').get(parentId, 'monday');
  assert.equal(Number(row.meetup_complete), 1);
  assert.equal(Number(row.tour_complete), 0);
});
