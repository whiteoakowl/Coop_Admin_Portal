// Coverage for a real request: "Family school management. Add a
// planner subpage. Here parent can create an annual plan for each
// student. With dates, title, description etc. View weekly plan grid
// for each student. Be able to add rows and columns to create plan
// grid for the week per student." (utils/familySchool.js, routes/
// parent-family-school.js's own /planner routes).
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

test('Planner nav entry appears under Family School Management', async () => {
  const familyId = await createFamily('Planner Nav Family');
  const parent = await createPortalMember({ name: 'Planner Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(page.text, /href="\/parent\/family-school\/planner"/);
});

test('Annual Plan: a parent can create and delete dated plan entries for their own student', async () => {
  const familyId = await createFamily('Annual Plan Family');
  const parent = await createPortalMember({ name: 'Annual Plan Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Annual Plan Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/planner');
  const createRes = await request(app)
    .post('/parent/family-school/planner/annual')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, startDate: '2026-09-01', endDate: '2026-09-05', title: 'Unit 1: Fractions', description: 'Intro to fractions week', _csrf: csrf });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.location, /notice=/);

  const page = await request(app).get(`/parent/family-school/planner?view=annual&studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Unit 1: Fractions/);
  assert.match(page.text, /Intro to fractions week/);

  const entry = await db.prepare('SELECT id FROM family_school_annual_plan_entries WHERE student_id = ?').get(student.memberId);
  const deleteRes = await request(app)
    .post(`/parent/family-school/planner/annual/${entry.id}/delete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(deleteRes.status, 302);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_annual_plan_entries WHERE id = ?').get(entry.id), undefined);
});

test('Annual Plan: missing a title or start date is rejected, and another family cannot delete this entry', async () => {
  const familyId = await createFamily('Annual Plan Validation Family');
  const parent = await createPortalMember({ name: 'Validation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Validation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/planner');

  const noTitleRes = await request(app)
    .post('/parent/family-school/planner/annual')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, startDate: '2026-09-01', title: '', _csrf: csrf });
  assert.match(noTitleRes.headers.location, /error=/);

  const { createAnnualPlanEntry } = require('../utils/familySchool');
  const entryId = await createAnnualPlanEntry({ studentId: student.memberId, startDate: '2026-09-01', endDate: null, title: 'Real Entry', description: null, createdByAccountId: null });

  const otherFamilyId = await createFamily('Annual Plan Other Family');
  const otherParent = await createPortalMember({ name: 'Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/planner');
  const hijackRes = await request(app)
    .post(`/parent/family-school/planner/annual/${entryId}/delete`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ _csrf: otherCsrf });
  assert.equal(hijackRes.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_annual_plan_entries WHERE id = ?').get(entryId), "another family's parent must not be able to delete this entry");
});

test('Weekly Plan Grid: opening a week lazily creates a 7-day grid, and a parent can add/delete rows and columns and save cell content', async () => {
  const familyId = await createFamily('Weekly Plan Family');
  const parent = await createPortalMember({ name: 'Weekly Plan Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Plan Student', familyId, memberType: 'student', roleKey: 'student' });

  // 2026-09-07 is a Monday - opening the grid for any day that week
  // should land on (and lazily create) the same Monday-keyed plan.
  const page = await request(app).get(`/parent/family-school/planner?view=weekly&studentId=${student.memberId}&week=2026-09-09`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Monday/);
  assert.match(page.text, /Sunday/);

  const plan = await db.prepare('SELECT * FROM family_school_weekly_plans WHERE student_id = ?').get(student.memberId);
  assert.equal(plan.week_start_date, '2026-09-07', 'the grid is keyed to that week\'s own Monday regardless of which day was requested');
  const columnCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM family_school_weekly_plan_columns WHERE plan_id = ?').get(plan.id)).n);
  assert.equal(columnCount, 7, 'a brand new week is seeded with exactly 7 day columns');

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/planner');
  await request(app)
    .post(`/parent/family-school/planner/weekly/${plan.id}/rows`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ label: 'Math', _csrf: csrf });
  const row = await db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE plan_id = ?').get(plan.id);
  assert.equal(row.label, 'Math');

  await request(app)
    .post(`/parent/family-school/planner/weekly/${plan.id}/columns`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ label: 'Notes', _csrf: csrf });
  const columnCountAfter = Number((await db.prepare('SELECT COUNT(*) AS n FROM family_school_weekly_plan_columns WHERE plan_id = ?').get(plan.id)).n);
  assert.equal(columnCountAfter, 8, 'a parent can add columns beyond the 7 seeded day columns');
  const notesColumn = await db.prepare("SELECT * FROM family_school_weekly_plan_columns WHERE plan_id = ? AND label = 'Notes'").get(plan.id);

  const cellRes = await request(app)
    .post('/parent/family-school/planner/weekly/cell')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ rowId: row.id, columnId: notesColumn.id, content: 'Fractions worksheet', _csrf: csrf });
  assert.equal(cellRes.status, 200);
  const cell = await db.prepare('SELECT content FROM family_school_weekly_plan_cells WHERE row_id = ? AND column_id = ?').get(row.id, notesColumn.id);
  assert.equal(cell.content, 'Fractions worksheet');

  const gridPage = await request(app).get(`/parent/family-school/planner?view=weekly&studentId=${student.memberId}&week=2026-09-07`).set('Cookie', parent.cookie);
  assert.match(gridPage.text, /value="Fractions worksheet"/);

  await request(app).post(`/parent/family-school/planner/weekly/rows/${row.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_rows WHERE id = ?').get(row.id), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_cells WHERE row_id = ?').get(row.id), undefined, 'deleting a row also removes its own cells');

  await request(app).post(`/parent/family-school/planner/weekly/columns/${notesColumn.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_columns WHERE id = ?').get(notesColumn.id), undefined);
});

test('Weekly Plan Grid: a different week for the same student is an independent grid, and another family cannot touch it', async () => {
  const familyId = await createFamily('Weekly Plan Isolation Family');
  const parent = await createPortalMember({ name: 'Weekly Isolation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Weekly Isolation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/planner');

  await request(app).get(`/parent/family-school/planner?view=weekly&studentId=${student.memberId}&week=2026-09-07`).set('Cookie', parent.cookie);
  const weekOnePlan = await db.prepare('SELECT * FROM family_school_weekly_plans WHERE student_id = ? AND week_start_date = ?').get(student.memberId, '2026-09-07');
  await request(app).post(`/parent/family-school/planner/weekly/${weekOnePlan.id}/rows`).set('Cookie', parent.cookie).type('form').send({ label: 'Week One Only Row', _csrf: csrf });

  const weekTwoPage = await request(app).get(`/parent/family-school/planner?view=weekly&studentId=${student.memberId}&week=2026-09-14`).set('Cookie', parent.cookie);
  assert.doesNotMatch(weekTwoPage.text, /Week One Only Row/, "a different week's grid must not inherit another week's own rows");

  const otherFamilyId = await createFamily('Weekly Plan Other Family');
  const otherParent = await createPortalMember({ name: 'Weekly Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/planner');
  const hijackRowRes = await request(app)
    .post(`/parent/family-school/planner/weekly/${weekOnePlan.id}/rows`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ label: 'Hijacked Row', _csrf: otherCsrf });
  assert.equal(hijackRowRes.status, 404);

  const row = await db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE plan_id = ? AND label = ?').get(weekOnePlan.id, 'Week One Only Row');
  const column = await db.prepare('SELECT * FROM family_school_weekly_plan_columns WHERE plan_id = ? LIMIT 1').get(weekOnePlan.id);
  const hijackCellRes = await request(app)
    .post('/parent/family-school/planner/weekly/cell')
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ rowId: row.id, columnId: column.id, content: 'Hijacked content', _csrf: otherCsrf });
  assert.equal(hijackCellRes.status, 404);
  assert.equal(await db.prepare('SELECT 1 FROM family_school_weekly_plan_cells WHERE row_id = ?').get(row.id), undefined);
});
