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
// schedule planner." (utils/familySchool.js, routes/parent-family-
// school.js's own /annual-planner and /schedule-planner routes).
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

test('Annual Planner and Schedule Planner nav entries appear under Family School Management', async () => {
  const familyId = await createFamily('Planner Nav Family');
  const parent = await createPortalMember({ name: 'Planner Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(page.text, /href="\/parent\/family-school\/annual-planner"/);
  assert.match(page.text, /href="\/parent\/family-school\/schedule-planner"/);
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

  const item = await db.prepare('SELECT id FROM family_school_curriculum_items WHERE student_id = ?').get(studentA.memberId);
  const deleteRes = await request(app).post(`/parent/family-school/annual-planner/${item.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(deleteRes.status, 302);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_curriculum_items WHERE id = ?').get(item.id), undefined);
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
  assert.equal(hijackRes.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_curriculum_items WHERE id = ?').get(itemId), "another family's parent must not be able to delete this item");
});

test('Schedule Planner: opening a week lazily creates a 7-day grid, and a parent can add/delete rows and columns and save cell content', async () => {
  const familyId = await createFamily('Schedule Planner Family');
  const parent = await createPortalMember({ name: 'Schedule Planner Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Schedule Planner Student', familyId, memberType: 'student', roleKey: 'student' });

  // 2026-09-07 is a Monday - opening the grid for any day that week
  // should land on (and lazily create) the same Monday-keyed plan.
  const page = await request(app).get(`/parent/family-school/schedule-planner?studentId=${student.memberId}&week=2026-09-09`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Monday/);
  assert.match(page.text, /Sunday/);

  const plan = await db.prepare('SELECT * FROM family_school_weekly_plans WHERE student_id = ?').get(student.memberId);
  assert.equal(plan.week_start_date, '2026-09-07', "the grid is keyed to that week's own Monday regardless of which day was requested");
  const columnCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM family_school_weekly_plan_columns WHERE plan_id = ?').get(plan.id)).n);
  assert.equal(columnCount, 7, 'a brand new week is seeded with exactly 7 day columns');

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/schedule-planner');
  await request(app)
    .post(`/parent/family-school/schedule-planner/${plan.id}/rows`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ label: 'Math', _csrf: csrf });
  const row = await db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE plan_id = ?').get(plan.id);
  assert.equal(row.label, 'Math');

  await request(app)
    .post(`/parent/family-school/schedule-planner/${plan.id}/columns`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ label: 'Notes', _csrf: csrf });
  const columnCountAfter = Number((await db.prepare('SELECT COUNT(*) AS n FROM family_school_weekly_plan_columns WHERE plan_id = ?').get(plan.id)).n);
  assert.equal(columnCountAfter, 8, 'a parent can add columns beyond the 7 seeded day columns');
  const notesColumn = await db.prepare("SELECT * FROM family_school_weekly_plan_columns WHERE plan_id = ? AND label = 'Notes'").get(plan.id);

  const cellRes = await request(app)
    .post('/parent/family-school/schedule-planner/cell')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ rowId: row.id, columnId: notesColumn.id, content: 'Fractions worksheet', _csrf: csrf });
  assert.equal(cellRes.status, 200);
  const cell = await db.prepare('SELECT content FROM family_school_weekly_plan_cells WHERE row_id = ? AND column_id = ?').get(row.id, notesColumn.id);
  assert.equal(cell.content, 'Fractions worksheet');

  const gridPage = await request(app).get(`/parent/family-school/schedule-planner?studentId=${student.memberId}&week=2026-09-07`).set('Cookie', parent.cookie);
  assert.match(gridPage.text, /value="Fractions worksheet"/);

  await request(app).post(`/parent/family-school/schedule-planner/rows/${row.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_rows WHERE id = ?').get(row.id), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_cells WHERE row_id = ?').get(row.id), undefined, "deleting a row also removes its own cells");

  await request(app).post(`/parent/family-school/schedule-planner/columns/${notesColumn.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_columns WHERE id = ?').get(notesColumn.id), undefined);
});

test('Schedule Planner: a different week for the same student is an independent grid, and another family cannot touch it', async () => {
  const familyId = await createFamily('Schedule Planner Isolation Family');
  const parent = await createPortalMember({ name: 'Schedule Isolation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Schedule Isolation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/schedule-planner');

  await request(app).get(`/parent/family-school/schedule-planner?studentId=${student.memberId}&week=2026-09-07`).set('Cookie', parent.cookie);
  const weekOnePlan = await db.prepare('SELECT * FROM family_school_weekly_plans WHERE student_id = ? AND week_start_date = ?').get(student.memberId, '2026-09-07');
  await request(app).post(`/parent/family-school/schedule-planner/${weekOnePlan.id}/rows`).set('Cookie', parent.cookie).type('form').send({ label: 'Week One Only Row', _csrf: csrf });

  const weekTwoPage = await request(app).get(`/parent/family-school/schedule-planner?studentId=${student.memberId}&week=2026-09-14`).set('Cookie', parent.cookie);
  assert.doesNotMatch(weekTwoPage.text, /Week One Only Row/, "a different week's grid must not inherit another week's own rows");

  const otherFamilyId = await createFamily('Schedule Planner Other Family');
  const otherParent = await createPortalMember({ name: 'Schedule Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/schedule-planner');
  const hijackRowRes = await request(app)
    .post(`/parent/family-school/schedule-planner/${weekOnePlan.id}/rows`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ label: 'Hijacked Row', _csrf: otherCsrf });
  assert.equal(hijackRowRes.status, 404);

  const row = await db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE plan_id = ? AND label = ?').get(weekOnePlan.id, 'Week One Only Row');
  const column = await db.prepare('SELECT * FROM family_school_weekly_plan_columns WHERE plan_id = ? LIMIT 1').get(weekOnePlan.id);
  const hijackCellRes = await request(app)
    .post('/parent/family-school/schedule-planner/cell')
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ rowId: row.id, columnId: column.id, content: 'Hijacked content', _csrf: otherCsrf });
  assert.equal(hijackCellRes.status, 404);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_cells WHERE row_id = ?').get(row.id), undefined);
});
