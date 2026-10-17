// Coverage for Main Admin Portal > Members > Grade Level Report - a real
// request: "Main admin portal. Members. Add a button that's says grade
// level report. When you click this page will show a bar bargraph
// members on every grade level. Also a grade level chart with names and
// ages in parenthesis. Column titles are grade levels. Shrink to fit all
// grade levels. Add print button to this page." (routes/main-admin-
// members.js's own GET /grade-level-report, views/main-admin-members-
// grade-level-report.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-grade-level-report-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-grade-level-report-test-uploads-${process.pid}`);
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
const { ageFromBirthday } = require('../utils/dates');

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

let seedCounter = 0;
async function createStudent({ name, gradeLevel, birthday, active = 1 }) {
  seedCounter += 1;
  const code = `gradereport${seedCounter}`;
  await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, grade_level, birthday, active) VALUES (?, ?, ?, 'student', ?, ?, ?)")
    .run(name, code, code, gradeLevel || null, birthday || null, active);
}
async function createParent(name) {
  seedCounter += 1;
  const code = `gradereportparent${seedCounter}`;
  await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)").run(name, code, code);
}

test('Members page offers a Grade Level Report button', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<a class="roster-action-btn" href="\/main-admin\/members\/grade-level-report"[^>]*>Grade Level Report<\/a>/);
});

test('Grade Level Report: no active students with a grade level at all shows an empty-state message, not a broken 0-column grid', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members/grade-level-report').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No active students have a grade level on file yet\./);
  assert.doesNotMatch(res.text, /grade-level-report-grid/);
});

test('Grade Level Report: grouping, ages, bar graph, Ungraded, Print button, non-student/inactive exclusion', async (t) => {
  const cookie = await loginAsMainAdmin();

  const kBirthday = '2020-01-01';
  const expectedKAge = ageFromBirthday(kBirthday);
  await createStudent({ name: 'Amy Kinder', gradeLevel: 'Kindergarten', birthday: kBirthday });
  await createStudent({ name: 'Zack Kinder', gradeLevel: 'Kindergarten', birthday: '2020-06-15' });
  await createStudent({ name: 'Third Grader', gradeLevel: '3rd', birthday: '2016-01-01' });
  await createStudent({ name: 'No Grade Student', gradeLevel: null, birthday: '2015-01-01' });
  await createStudent({ name: 'Inactive Kinder', gradeLevel: 'Kindergarten', birthday: '2020-01-01', active: 0 });
  await createParent('Some Parent');

  const res = await request(app).get('/main-admin/members/grade-level-report').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('column titles are grade levels, names show with age in parentheses, sorted alphabetically within a column', () => {
    const kColMatch = /<div class="grade-level-report-col-title" title="Kindergarten">Kindergarten<\/div>([\s\S]*?)<\/div>\s*<div class="grade-level-report-col">/.exec(res.text + '<div class="grade-level-report-col">');
    assert.ok(kColMatch, 'expected a Kindergarten column');
    const colBody = kColMatch[1];
    assert.match(colBody, new RegExp(`<p class="grade-level-report-name">Amy Kinder \\(${expectedKAge}\\)</p>`));
    assert.match(colBody, /<p class="grade-level-report-name">Zack Kinder \(\d+\)<\/p>/);
    // Alphabetical: Amy before Zack.
    assert.ok(colBody.indexOf('Amy Kinder') < colBody.indexOf('Zack Kinder'));
  });

  await t.test('a 3rd grade column exists with its own single student', () => {
    assert.match(res.text, /<div class="grade-level-report-col-title" title="3rd">3rd<\/div>\s*<p class="grade-level-report-name">Third Grader \(\d+\)<\/p>/);
  });

  await t.test('an inactive (archived) student is excluded entirely', () => {
    assert.doesNotMatch(res.text, /Inactive Kinder/);
  });

  await t.test('a non-student (parent) member is excluded entirely', () => {
    assert.doesNotMatch(res.text, /Some Parent/);
  });

  await t.test('a student with no grade level on file lands in a trailing Ungraded column', () => {
    assert.match(res.text, /<div class="grade-level-report-col-title" title="Ungraded">Ungraded<\/div>\s*<p class="grade-level-report-name">No Grade Student \(\d+\)<\/p>/);
  });

  await t.test('the bar graph shows a bar per non-empty grade level with the right count', () => {
    const kBarMatch = /<span class="grade-level-bar-count">2<\/span>\s*<div class="grade-level-bar-track">\s*<div class="grade-level-bar" style="height: 100%;">/.exec(res.text);
    assert.ok(kBarMatch, 'Kindergarten (2 students, the largest group) should be a 100%-height bar labeled 2');
    const thirdBarMatch = /<span class="grade-level-bar-count">1<\/span>\s*<div class="grade-level-bar-track">\s*<div class="grade-level-bar" style="height: 50%;">/.exec(res.text);
    assert.ok(thirdBarMatch, '3rd grade (1 of 2 max) should be a 50%-height bar labeled 1');
  });

  await t.test('grade level columns are laid out as a CSS grid, not a table, sized to exactly how many grade levels have students (and half that, rounded up, on mobile so columns wrap onto a 2nd row)', () => {
    // Kindergarten, 3rd, Ungraded = 3 non-empty columns.
    assert.match(res.text, /<div class="grade-level-report-fit-inner" style="--grade-level-cols: 3; --grade-level-cols-mobile: 2;">/);
    assert.match(res.text, /<div class="grade-level-report-grid">/);
  });

  await t.test('a Print button and the shrink-to-fit script are present', () => {
    assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="window\.print\(\)">Print<\/button>/);
    assert.match(res.text, /<script src="\/js\/shrink-title-to-fit\.js"><\/script>/);
    assert.match(res.text, /data-shrink-to-fit-on-print/);
  });

  await t.test('a Filter button opens a dialog offering Section/Signup/Family dropdowns', () => {
    assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('grade-level-report-filter-dialog'\)\.showModal\(\)">/);
    assert.match(res.text, /<select id="grade-level-report-section-select" name="sectionId">/);
    assert.match(res.text, /<select id="grade-level-report-signup-select" name="signup">/);
    assert.match(res.text, /<select id="grade-level-report-family-select" name="familyId">/);
  });
});

test('Grade Level Report: filter by section, schedule grid signup, and family', async (t) => {
  const cookie = await loginAsMainAdmin();

  const familyAId = (await db.prepare("INSERT INTO families (name) VALUES ('Alpha')").run()).lastInsertRowid;
  const familyBId = (await db.prepare("INSERT INTO families (name) VALUES ('Beta')").run()).lastInsertRowid;
  const sectionId = (await db.prepare("INSERT INTO sections (name) VALUES ('Teen Co-op')").run()).lastInsertRowid;

  async function createStudentWithFamily({ name, gradeLevel, familyId }) {
    seedCounter += 1;
    const code = `gradereportfilter${seedCounter}`;
    const id = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_code, member_type, grade_level, active, family_id) VALUES (?, ?, ?, 'student', ?, 1, ?)")
        .run(name, code, code, gradeLevel, familyId)
    ).lastInsertRowid;
    return id;
  }

  const sectionedId = await createStudentWithFamily({ name: 'Sectioned Student', gradeLevel: '5th', familyId: familyAId });
  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(sectionedId, sectionId);
  const unsectionedId = await createStudentWithFamily({ name: 'Unsectioned Student', gradeLevel: '5th', familyId: familyBId });

  const enrolledId = await createStudentWithFamily({ name: 'Enrolled Student', gradeLevel: '6th', familyId: familyAId });
  const classId = (
    await db
      .prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Filter Test Class')")
      .run()
  ).lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, enrolledId);
  const notEnrolledId = await createStudentWithFamily({ name: 'Not Enrolled Student', gradeLevel: '6th', familyId: familyBId });

  await t.test('sectionId filters to only members holding that section', async () => {
    const res = await request(app).get(`/main-admin/members/grade-level-report?sectionId=${sectionId}`).set('Cookie', cookie);
    assert.match(res.text, /Sectioned Student/);
    assert.doesNotMatch(res.text, /Unsectioned Student/);
    assert.match(res.text, /Filter: Teen Co-op/, 'the Filter button label should reflect the active section filter');
  });

  // "Not Enrolled Student" contains "Enrolled Student" as a plain
  // substring, so these match against the exact rendered name tag
  // (/>Enrolled Student</) rather than a bare substring search.
  await t.test('signup=signedUp filters to students enrolled in at least one class', async () => {
    const res = await request(app).get('/main-admin/members/grade-level-report?signup=signedUp').set('Cookie', cookie);
    assert.match(res.text, /<p class="grade-level-report-name">Enrolled Student<\/p>/);
    assert.doesNotMatch(res.text, /<p class="grade-level-report-name">Not Enrolled Student<\/p>/);
  });

  await t.test('signup=notSignedUp filters to students with no class enrollment', async () => {
    const res = await request(app).get('/main-admin/members/grade-level-report?signup=notSignedUp').set('Cookie', cookie);
    assert.doesNotMatch(res.text, /<p class="grade-level-report-name">Enrolled Student<\/p>/);
    assert.match(res.text, /<p class="grade-level-report-name">Not Enrolled Student<\/p>/);
  });

  await t.test('familyId filters to only that family\'s members', async () => {
    const res = await request(app).get(`/main-admin/members/grade-level-report?familyId=${familyAId}`).set('Cookie', cookie);
    assert.match(res.text, /Sectioned Student/);
    assert.doesNotMatch(res.text, /Unsectioned Student/);
    assert.match(res.text, /Filter: Alpha Family/);
  });

  await t.test('a Clear Filter link appears only once a filter is active', async () => {
    const unfiltered = await request(app).get('/main-admin/members/grade-level-report').set('Cookie', cookie);
    assert.doesNotMatch(unfiltered.text, /Clear Filter/);
    const filtered = await request(app).get(`/main-admin/members/grade-level-report?familyId=${familyAId}`).set('Cookie', cookie);
    assert.match(filtered.text, /Clear Filter/);
  });
});

