// Coverage for a real request: "Family school management. Add a
// planner subpage. Here parent can create an annual plan for each
// student. With dates, title, description etc. View weekly plan grid
// for each student. Be able to add rows and columns to create plan
// grid for the week per student." Later split into two separate named
// subpages with a redefined Annual Planner shape: "Family management
// should also have a subpage called annual planner where it is
// organized by student and you add curriculum under each student. Pop
// up asks for curriculum name, brand, level and price," and "The other
// new planner page under family school management should be called
// schedule planner" (renamed again shortly after: "Change schedule
// planner to weekly planner"). (utils/familySchool.js, routes/parent-
// family-school.js's own /annual-planner and /weekly-planner routes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `family-school-planner-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `family-school-planner-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `fsplan${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey === 'main_admin' ? 'main-admin' : roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

// Family School Management is its own portal now (test/family-school-
// management.test.js covers the switch), so its Annual Planner/Weekly
// Planner tabs are checked on its own nav (/parent/family-school), not
// on Parent Portal's.
test('Annual Planner and Weekly Planner nav entries appear under Family School Management', async () => {
  const familyId = await createFamily('Planner Nav Family');
  const parent = await createPortalMember({ name: 'Planner Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.match(page.text, /href="\/parent\/family-school\/annual-planner"/);
  assert.match(page.text, /href="\/parent\/family-school\/weekly-planner"/);
});

test('Annual Planner: organized by student, a parent can add and delete curriculum items', async () => {
  const familyId = await createFamily('Curriculum Family');
  const parent = await createPortalMember({ name: 'Curriculum Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Curriculum Student A', familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: 'Curriculum Student B', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/annual-planner');
  const createRes = await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: studentA.memberId, name: 'Saxon Math 5', brand: 'Saxon', level: '5th Grade', price: '79.99', _csrf: csrf });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.location, /notice=/);

  // A real request: "Annual planner, add a total for curriculum cost
  // next to each student name." A second item for the same student
  // confirms the total is a real sum, not just echoing one item's price.
  await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: studentA.memberId, name: 'Science Kit', price: '20.01', _csrf: csrf });

  const page = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  const studentAIndex = page.text.indexOf('Curriculum Student A');
  const curriculumIndex = page.text.indexOf('Saxon Math 5');
  const studentBIndex = page.text.indexOf('Curriculum Student B');
  assert.ok(studentAIndex !== -1 && curriculumIndex !== -1 && studentBIndex !== -1, 'both students and the curriculum item must render');
  assert.ok(studentAIndex < curriculumIndex && curriculumIndex < studentBIndex, "the curriculum item must render under student A's own section, before student B's");
  assert.match(page.text, /Saxon/);
  assert.match(page.text, /5th Grade/);
  assert.match(page.text, /\$79\.99/);
  // 79.99 + 20.01 = 100.00, shown next to Student A's own name, before
  // Student B's section (which has no items at all, so its own total is
  // $0.00).
  const totalAIndex = page.text.indexOf('Total: $100.00');
  assert.ok(totalAIndex !== -1 && totalAIndex > studentAIndex && totalAIndex < studentBIndex, "expected Student A's own curriculum total to sum both items");
  assert.match(page.text, /Total: \$0\.00/, "a student with no curriculum items yet still shows a $0.00 total");

  const item = await db.prepare('SELECT id FROM family_school_curriculum_items WHERE student_id = ? AND name = ?').get(studentA.memberId, 'Saxon Math 5');
  // A real request: "No refresh page when delete, it simple disappears"
  // - JSON in/out now, same shape as the Weekly Planner move route.
  const deleteRes = await request(app).post(`/parent/family-school/annual-planner/${item.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(deleteRes.status, 200);

  // The total recomputes on the next full page load too (not just the
  // in-place client-side subtraction after the AJAX delete above).
  const afterDeletePage = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.match(afterDeletePage.text, /Total: \$20\.01/);
  assert.equal(deleteRes.body.ok, true);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_curriculum_items WHERE id = ?').get(item.id), undefined);
});

// A real request: "Add edit and delete icons to all annual planning
// curriculum rows that are added."
test('Annual Planner: each curriculum row has an Edit icon pre-fillable from its own data, the edit route updates it, and another family cannot edit it', async () => {
  const familyId = await createFamily('Curriculum Edit Family');
  const parent = await createPortalMember({ name: 'Curriculum Edit Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Curriculum Edit Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/annual-planner');
  const createRes = await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, name: 'Saxon Math 5', brand: 'Saxon', level: '5th Grade', price: '79.99', _csrf: csrf });
  assert.equal(createRes.status, 302);

  const item = await db.prepare('SELECT id FROM family_school_curriculum_items WHERE student_id = ?').get(student.memberId);
  const page = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.match(page.text, new RegExp(`data-edit-curriculum="${item.id}"[\\s\\S]*?data-name="Saxon Math 5"`));
  assert.match(page.text, new RegExp(`data-delete-curriculum="${item.id}"`));
  assert.match(page.text, new RegExp(`<tr data-curriculum-id="${item.id}">`));

  const editRes = await request(app)
    .post(`/parent/family-school/annual-planner/${item.id}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Saxon Math 6', brand: 'Saxon', level: '6th Grade', price: '89.99', _csrf: csrf });
  assert.equal(editRes.status, 302);
  assert.match(editRes.headers.location, /notice=/);
  const updated = await db.prepare('SELECT * FROM family_school_curriculum_items WHERE id = ?').get(item.id);
  assert.equal(updated.name, 'Saxon Math 6');
  assert.equal(updated.level, '6th Grade');
  assert.equal(String(updated.price), '89.99');

  const otherFamilyId = await createFamily('Curriculum Edit Other Family');
  const otherParent = await createPortalMember({ name: 'Curriculum Edit Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/annual-planner');
  const hijackEditRes = await request(app)
    .post(`/parent/family-school/annual-planner/${item.id}/edit`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ name: 'Hijacked', _csrf: otherCsrf });
  assert.equal(hijackEditRes.status, 404);
  const stillUpdated = await db.prepare('SELECT name FROM family_school_curriculum_items WHERE id = ?').get(item.id);
  assert.equal(stillUpdated.name, 'Saxon Math 6');
});

// A real request: "Annual planner, student name and cost total should
// shrink to fit on one line. Edit and trash icons on each curriculum
// card should be on the title row to the right. Shrink cards by height,
// about half to be able to view more at once on mobile."
test('Annual Planner: the student header and curriculum table carry the shrink-to-fit/title-row CSS hooks', async () => {
  const familyId = await createFamily('Curriculum Shrink Family');
  const parent = await createPortalMember({ name: 'Curriculum Shrink Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Curriculum Shrink Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/annual-planner');
  await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, name: 'Shrink Test Curriculum', price: '10', _csrf: csrf });

  const page = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  // The name and total each have their own shrink/truncate slot inside
  // one flex header, instead of being plain text + a bare .hint span.
  assert.match(page.text, /<h2 class="fs-annual-planner-student-header">\s*<span class="fs-annual-planner-student-name">Curriculum Shrink Student<\/span>\s*<span class="hint fs-annual-planner-student-total" data-curriculum-total>Total: \$10\.00<\/span>\s*<\/h2>/);
  // The curriculum table itself carries the scoped class its own mobile
  // CSS reorders the Subject/Edit/Delete cells onto one row with -
  // DOM order (desktop's real column order) is otherwise untouched.
  assert.match(page.text, /<table class="roster-table members-table condensed-table table-stack-mobile fs-annual-planner-curriculum-table">/);
  const row = /<tr data-curriculum-id="\d+">([\s\S]*?)<\/tr>/.exec(page.text)[1];
  assert.match(row, /table-stack-heading[\s\S]*Curriculum[\s\S]*Brand[\s\S]*Level[\s\S]*Price[\s\S]*accounting-row-icons/, 'desktop column order (Subject, Curriculum, Brand, Level, Price, icons) is unchanged');
});

test('Annual Planner: a curriculum name is required, and another family cannot delete this item', async () => {
  const familyId = await createFamily('Curriculum Validation Family');
  const parent = await createPortalMember({ name: 'Curriculum Validation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Curriculum Validation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/annual-planner');

  const noNameRes = await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, name: '', _csrf: csrf });
  assert.match(noNameRes.headers.location, /error=/);

  const { createCurriculumItem } = require('../utils/familySchool');
  const itemId = await createCurriculumItem({ studentId: student.memberId, name: 'Real Curriculum', brand: null, level: null, price: null, createdByAccountId: null });

  const otherFamilyId = await createFamily('Curriculum Other Family');
  const otherParent = await createPortalMember({ name: 'Curriculum Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/annual-planner');
  const hijackRes = await request(app).post(`/parent/family-school/annual-planner/${itemId}/delete`).set('Cookie', otherParent.cookie).type('form').send({ _csrf: otherCsrf });
  assert.equal(hijackRes.status, 200);
  assert.equal(hijackRes.body.ok, false);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_curriculum_items WHERE id = ?').get(itemId), "another family's parent must not be able to delete this item");
});

// A real request: "add curriculum, add a subject bar... Add a dropdown
// menu for selecting a school year." (routes/parent-family-school.js's
// own resolveSchoolYearFilter/currentSchoolYear/schoolYearOptions).
test('Annual Planner: a curriculum item carries a Subject and a School Year, and the year dropdown filters the page', async () => {
  const familyId = await createFamily('School Year Family');
  const parent = await createPortalMember({ name: 'School Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'School Year Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/annual-planner');

  const createRes = await request(app)
    .post('/parent/family-school/annual-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, name: 'Saxon Math 5', subject: 'Math', brand: 'Saxon', level: '5th Grade', price: '79.99', schoolYear: '2026-2027', _csrf: csrf });
  assert.equal(createRes.status, 302);

  const matchingYear = await request(app).get('/parent/family-school/annual-planner?schoolYear=2026-2027').set('Cookie', parent.cookie);
  assert.match(matchingYear.text, /Saxon Math 5/);
  assert.match(matchingYear.text, /Math<\/td>/);

  const otherYear = await request(app).get('/parent/family-school/annual-planner?schoolYear=2020-2021').set('Cookie', parent.cookie);
  assert.doesNotMatch(otherYear.text, /Saxon Math 5/);

  const allYears = await request(app).get('/parent/family-school/annual-planner?schoolYear=all').set('Cookie', parent.cookie);
  assert.match(allYears.text, /Saxon Math 5/);

  const item = await db.prepare('SELECT subject, school_year FROM family_school_curriculum_items WHERE student_id = ?').get(student.memberId);
  assert.equal(item.subject, 'Math');
  assert.equal(item.school_year, '2026-2027');
});

// A real request: "add a print, pdf and export icons."
test('Annual Planner: Export CSV, Print preview, and Download PDF all respect the selected school year', async () => {
  const familyId = await createFamily('Planner Buttons Family');
  const parent = await createPortalMember({ name: 'Planner Buttons Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Planner Buttons Student', familyId, memberType: 'student', roleKey: 'student' });
  const { createCurriculumItem } = require('../utils/familySchool');
  await createCurriculumItem({ studentId: student.memberId, name: 'Button Curriculum', subject: 'Science', brand: null, level: null, price: 20, schoolYear: '2026-2027', createdByAccountId: null });

  const liveRes = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.match(liveRes.text, /href="\/parent\/family-school\/annual-planner\/export\.csv\?schoolYear=/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/annual-planner\/print\?schoolYear=[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/annual-planner\/download\.pdf\?schoolYear=/);

  const csvRes = await request(app).get('/parent/family-school/annual-planner/export.csv?schoolYear=2026-2027').set('Cookie', parent.cookie);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.text, /"Button Curriculum"/);
  assert.match(csvRes.text, /"Science"/);

  const previewRes = await request(app).get('/parent/family-school/annual-planner/print?schoolYear=2026-2027').set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /print-preview-header/);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /Button Curriculum/);

  const pdfRes = await request(app)
    .get('/parent/family-school/annual-planner/download.pdf?schoolYear=2026-2027')
    .set('Cookie', parent.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

// A real follow-up request completely redesigned Weekly Planner: "Add
// week button. Popup allows you to choose up to 7 dates. And add a
// title such as week 1, week 2 etc... Add an assignment button. Pop up
// allows you to write subject, title of assignment or dropdown to
// choose an assignment from family management assignments from parent
// created classes... Weekly plan should allow you to make a different
// weekly plan for each student, parent weekly plan and family weekly
// plan."
test('Weekly Planner: a parent can create a named week from chosen dates, add a free-text assignment, and delete both', async () => {
  const familyId = await createFamily('Weekly Planner Family');
  const parent = await createPortalMember({ name: 'Weekly Planner Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Planner Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');

  // Deliberately not 7 consecutive days - "choose up to 7 dates", not a
  // real calendar week.
  const createRes = await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'student', studentId: student.memberId, title: 'Week 1', date: ['2026-09-07', '2026-09-09', '2026-09-30'], _csrf: csrf });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.location, /notice=/);

  const week = await db.prepare("SELECT * FROM family_school_weeks WHERE title = 'Week 1'").get();
  assert.equal(week.owner_type, 'student');
  assert.equal(week.student_id, student.memberId);
  const weekDates = await db.prepare('SELECT date FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(week.id);
  assert.deepEqual(weekDates.map((d) => d.date), ['2026-09-07', '2026-09-09', '2026-09-30']);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${week.id}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Week 1/);

  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? AND date = ?').get(week.id, '2026-09-09');
  const assignRes = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateRow.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ subject: 'Math', title: 'Fractions worksheet', _csrf: csrf });
  assert.equal(assignRes.status, 302);
  const assignment = await db.prepare('SELECT * FROM family_school_week_assignments WHERE week_date_id = ?').get(dateRow.id);
  assert.equal(assignment.subject, 'Math');
  assert.equal(assignment.title, 'Fractions worksheet');

  const gridPage = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${week.id}`).set('Cookie', parent.cookie);
  assert.match(gridPage.text, /Fractions worksheet/);

  // A real request: "No refresh page when delete, it simple disappears"
  // - JSON in/out now, same shape as the move route below.
  const deleteAssignRes = await request(app).post(`/parent/family-school/weekly-planner/assignments/${assignment.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(deleteAssignRes.status, 200);
  assert.equal(deleteAssignRes.body.ok, true);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_week_assignments WHERE id = ?').get(assignment.id), undefined);

  await request(app).post(`/parent/family-school/weekly-planner/${week.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weeks WHERE id = ?').get(week.id), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_week_dates WHERE week_id = ?').get(week.id), undefined, 'deleting a week also removes its own dates');
});

// A real request: "Add edit icon and delete to all weekly planner
// assignments."
test('Weekly Planner: each assignment has an Edit icon pre-fillable from its own data, the edit route updates it, and another family cannot edit or delete it', async () => {
  const familyId = await createFamily('Weekly Planner Edit Family');
  const parent = await createPortalMember({ name: 'Weekly Planner Edit Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Planner Edit Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');

  const createRes = await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'student', studentId: student.memberId, title: 'Week 1', date: ['2026-10-05'], _csrf: csrf });
  assert.equal(createRes.status, 302);
  const week = await db.prepare("SELECT * FROM family_school_weeks WHERE title = 'Week 1' AND student_id = ?").get(student.memberId);
  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').get(week.id);

  const assignRes = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateRow.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ subject: 'Math', title: 'Fractions worksheet', description: 'Pages 1-3', link: 'https://example.com', grade: 'A', _csrf: csrf });
  assert.equal(assignRes.status, 302);
  const assignment = await db.prepare('SELECT * FROM family_school_week_assignments WHERE week_date_id = ?').get(dateRow.id);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${week.id}`).set('Cookie', parent.cookie);
  assert.match(page.text, new RegExp(`data-edit-assignment="${assignment.id}"[\\s\\S]*?data-title="Fractions worksheet"`));
  assert.match(page.text, new RegExp(`data-delete-assignment="${assignment.id}"`));

  const editRes = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignment.id}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ subject: 'Math', title: 'Fractions worksheet - revised', description: 'Pages 1-5', link: 'https://example.com/2', grade: 'A+', _csrf: csrf });
  assert.equal(editRes.status, 302);
  assert.match(editRes.headers.location, /notice=/);
  const updated = await db.prepare('SELECT * FROM family_school_week_assignments WHERE id = ?').get(assignment.id);
  assert.equal(updated.title, 'Fractions worksheet - revised');
  assert.equal(updated.description, 'Pages 1-5');
  assert.equal(updated.grade, 'A+');

  const otherFamilyId = await createFamily('Weekly Planner Edit Other Family');
  const otherParent = await createPortalMember({ name: 'Weekly Planner Edit Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/weekly-planner');

  const hijackEditRes = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignment.id}/edit`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ title: 'Hijacked', _csrf: otherCsrf });
  assert.equal(hijackEditRes.status, 404);

  const hijackDeleteRes = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignment.id}/delete`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ _csrf: otherCsrf });
  assert.equal(hijackDeleteRes.status, 200);
  assert.equal(hijackDeleteRes.body.ok, false);

  const stillUpdated = await db.prepare('SELECT title FROM family_school_week_assignments WHERE id = ?').get(assignment.id);
  assert.equal(stillUpdated.title, 'Fractions worksheet - revised');
});

// A real request: "a label that says the week title with an edit icon
// on it. When you click the edit icon it allows you to edit the week
// such as the dates, title, description or delete the week
// completely. Remove the trash button on weekly planner view."
test('Weekly Planner: the week title shows with an Edit icon (no bare trash button), and Edit updates title/description/dates in place', async () => {
  const familyId = await createFamily('Weekly Planner Edit Week Family');
  const parent = await createPortalMember({ name: 'Weekly Planner Edit Week Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Planner Edit Week Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');

  await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'student', studentId: student.memberId, title: 'Week 1', date: ['2026-11-02', '2026-11-04'], _csrf: csrf });
  const week = await db.prepare("SELECT * FROM family_school_weeks WHERE title = 'Week 1' AND student_id = ?").get(student.memberId);
  const dateRows = await db.prepare('SELECT * FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(week.id);
  const keptDateId = dateRows[0].id;
  const removedDateId = dateRows[1].id;

  // An assignment on each of the two dates - editing the week down to
  // just the first date should keep the first assignment (same date
  // row id, just a corrected date value) and drop the second (its own
  // date row no longer exists at all).
  await request(app).post(`/parent/family-school/weekly-planner/dates/${keptDateId}/assignments`).set('Cookie', parent.cookie).type('form').send({ title: 'Kept Assignment', _csrf: csrf });
  await request(app).post(`/parent/family-school/weekly-planner/dates/${removedDateId}/assignments`).set('Cookie', parent.cookie).type('form').send({ title: 'Removed Assignment', _csrf: csrf });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${week.id}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /fs-weekly-plan-week-title">Week 1</, 'the week title shows as a label');
  assert.doesNotMatch(page.text, /aria-label="Delete week"/, 'the old bare trash button should be gone');
  assert.match(page.text, /aria-label="Edit week"/);
  assert.match(page.text, /id="edit-week-dialog"/);
  // Pre-filled straight from the week's own current data.
  assert.match(page.text, /name="title" value="Week 1"/);
  assert.match(page.text, /name="date" value="2026-11-02"/);
  assert.match(page.text, /name="date" value="2026-11-04"/);

  const editRes = await request(app)
    .post(`/parent/family-school/weekly-planner/${week.id}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ title: 'Week 1 - Revised', description: 'Focus on fractions this week', date: ['2026-11-03'], _csrf: csrf });
  assert.equal(editRes.status, 302);
  assert.match(editRes.headers.location, /notice=/);

  const updatedWeek = await db.prepare('SELECT * FROM family_school_weeks WHERE id = ?').get(week.id);
  assert.equal(updatedWeek.title, 'Week 1 - Revised');
  assert.equal(updatedWeek.description, 'Focus on fractions this week');

  const updatedDates = await db.prepare('SELECT * FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(week.id);
  assert.equal(updatedDates.length, 1, 'the dropped second date is gone entirely');
  assert.equal(updatedDates[0].id, keptDateId, 'the first date row keeps its own id - just a corrected date value');
  assert.equal(updatedDates[0].date, '2026-11-03');

  // The kept date's own assignment survived (same date row id); the
  // removed date's assignment is gone with it.
  assert.ok(await db.prepare('SELECT 1 FROM family_school_week_assignments WHERE week_date_id = ?').get(keptDateId));
  assert.equal(await db.prepare('SELECT 1 FROM family_school_week_dates WHERE id = ?').get(removedDateId), undefined);

  // A different family can't edit or delete via these routes either.
  const otherFamilyId = await createFamily('Weekly Planner Edit Week Other Family');
  const otherParent = await createPortalMember({ name: 'Weekly Planner Edit Week Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/weekly-planner');
  const hijackRes = await request(app)
    .post(`/parent/family-school/weekly-planner/${week.id}/edit`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ title: 'Hijacked', date: ['2026-11-03'], _csrf: otherCsrf });
  assert.equal(hijackRes.status, 404);
});

test('Weekly Planner: an assignment can be picked from an existing class assignment instead of typed by hand', async () => {
  const familyId = await createFamily('Weekly Planner Dropdown Family');
  const parent = await createPortalMember({ name: 'Weekly Planner Dropdown Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Planner Dropdown Student', familyId, memberType: 'student', roleKey: 'student' });
  const { createClass, createLesson, createContentItem, createWeek, createWeekAssignment } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Dropdown Class', description: null, createdByAccountId: null });
  const lessonId = await createLesson({ classId, title: 'Dropdown Lesson', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_upload', title: 'Essay Draft', pointsPossible: 10 });
  const weekId = await createWeek({ familyId, ownerType: 'student', studentId: student.memberId, title: 'Week 2', dates: ['2026-10-05'], createdByAccountId: null });
  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').get(weekId);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /Dropdown Class.*Essay Draft|Essay Draft/);
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');

  const assignRes = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateRow.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ contentItemId: itemId, subject: '', title: '', _csrf: csrf });
  assert.equal(assignRes.status, 302);
  const assignment = await db.prepare('SELECT * FROM family_school_week_assignments WHERE week_date_id = ?').get(dateRow.id);
  assert.equal(assignment.content_item_id, itemId);
  assert.equal(assignment.title, 'Essay Draft');
  assert.equal(assignment.subject, 'Dropdown Class');

  // Direct function coverage too, independent of the route's own
  // request shape.
  const directId = await createWeekAssignment({ weekDateId: dateRow.id, subject: 'Science', title: 'Lab report', contentItemId: null });
  assert.ok(directId);
});

test('Weekly Planner: student, parent, and family weeks for the same family are independent, and another family cannot touch any of them', async () => {
  const familyId = await createFamily('Weekly Planner Isolation Family');
  const parent = await createPortalMember({ name: 'Isolation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Isolation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');

  await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'student', studentId: student.memberId, title: 'Student Week', date: ['2026-11-02'], _csrf: csrf });
  await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'parent', title: 'Parent Week', date: ['2026-11-02'], _csrf: csrf });
  await request(app)
    .post('/parent/family-school/weekly-planner')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ ownerType: 'family', title: 'Family Week', date: ['2026-11-02'], _csrf: csrf });

  const studentWeeksPage = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}`).set('Cookie', parent.cookie);
  assert.match(studentWeeksPage.text, /Student Week/);
  assert.doesNotMatch(studentWeeksPage.text, /Parent Week/);
  assert.doesNotMatch(studentWeeksPage.text, /Family Week/);

  const parentWeeksPage = await request(app).get('/parent/family-school/weekly-planner?owner=parent').set('Cookie', parent.cookie);
  assert.match(parentWeeksPage.text, /Parent Week/);
  assert.doesNotMatch(parentWeeksPage.text, /Student Week/);

  const familyWeeksPage = await request(app).get('/parent/family-school/weekly-planner?owner=family').set('Cookie', parent.cookie);
  assert.match(familyWeeksPage.text, /Family Week/);
  assert.doesNotMatch(familyWeeksPage.text, /Parent Week/);

  // A student sees their own week and the family's, never the parent's.
  const studentWeek = await db.prepare("SELECT id FROM family_school_weeks WHERE title = 'Student Week'").get();
  const studentPortalPage = await request(app).get('/student/family-school/weekly-planner').set('Cookie', student.cookie);
  assert.match(studentPortalPage.text, /Student Week/);
  assert.match(studentPortalPage.text, /Family Week/);
  assert.doesNotMatch(studentPortalPage.text, /Parent Week/);

  const otherFamilyId = await createFamily('Weekly Planner Other Family');
  const otherParent = await createPortalMember({ name: 'Other Family Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/weekly-planner');
  const hijackRes = await request(app).post(`/parent/family-school/weekly-planner/${studentWeek.id}/delete`).set('Cookie', otherParent.cookie).type('form').send({ _csrf: otherCsrf });
  assert.equal(hijackRes.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_weeks WHERE id = ?').get(studentWeek.id), "another family's parent must not be able to delete this week");
});

test('Weekly Planner: Print preview and Download PDF title the page with the owner and the date range', async () => {
  const familyId = await createFamily('Weekly Planner Print Family');
  const parent = await createPortalMember({ name: 'Weekly Planner Print Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Planner Print Student', familyId, memberType: 'student', roleKey: 'student' });
  const { createWeek, createWeekAssignment } = require('../utils/familySchool');
  const weekId = await createWeek({ familyId, ownerType: 'student', studentId: student.memberId, title: 'Week 3', dates: ['2026-12-01', '2026-12-04'], createdByAccountId: null });
  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? ORDER BY position LIMIT 1').get(weekId);
  await createWeekAssignment({ weekDateId: dateRow.id, subject: 'History', title: 'Read chapter 4', contentItemId: null });

  const liveRes = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(liveRes.text, new RegExp(`href="/parent/family-school/weekly-planner/print\\?weekId=${weekId}" target="_blank" aria-label="Print"`));
  assert.match(liveRes.text, new RegExp(`href="/parent/family-school/weekly-planner/download\\.pdf\\?weekId=${weekId}" aria-label="Download PDF"`));

  const previewRes = await request(app).get(`/parent/family-school/weekly-planner/print?weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /print-preview-header/);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /Weekly Planner Print Student/, 'title should be the student\'s own name');
  assert.match(previewRes.text, /Dec(ember)? 1.*Dec(ember)? 4/, 'title should carry the date range for the week');
  assert.match(previewRes.text, /Read chapter 4/);

  const pdfRes = await request(app)
    .get(`/parent/family-school/weekly-planner/download.pdf?weekId=${weekId}`)
    .set('Cookie', parent.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});
