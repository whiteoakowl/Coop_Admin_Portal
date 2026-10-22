// Coverage for two real requests on the Weekly Planner v2 (utils/
// familySchool.js / routes/parent-family-school.js's own weekly-planner
// routes, see family-school-planner.test.js's own header comment for
// the feature's full history): "allow to drag and drop lessons and
// assignments between days" (routes/parent-family-school.js's new POST
// .../assignments/:id/move + utils/familySchool.js's new
// moveWeekAssignment) and "show a circle graph for each week below the
// week plan that shows percentage of each subject" (utils/
// familySchool.js's new subjectBreakdownForGrid + views/partials/
// family-school-subject-chart.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `weekly-planner-dragdrop-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `weekly-planner-dragdrop-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { createWeek, createWeekAssignment } = require('../utils/familySchool');

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

async function createParent(familyId) {
  counter += 1;
  const code = `wpdd${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Parent ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

test('moving an assignment to another day within the same week updates its week_date_id', async () => {
  const familyId = await createFamily('DragDrop Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Drag Week', dates: ['2026-11-02', '2026-11-03'], createdByAccountId: null });
  const [dateA, dateB] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(weekId);
  const assignmentId = await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Worksheet', contentItemId: null });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignmentId}/move`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ weekDateId: dateB.id, _csrf: csrf });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const row = await db.prepare('SELECT week_date_id FROM family_school_week_assignments WHERE id = ?').get(assignmentId);
  assert.equal(row.week_date_id, dateB.id);
});

test('moving an assignment to a date belonging to a DIFFERENT week is rejected', async () => {
  const familyId = await createFamily('DragDrop Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Week One', dates: ['2026-11-09'], createdByAccountId: null });
  const otherWeekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Week Two', dates: ['2026-11-16'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);
  const [otherDate] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(otherWeekId);
  const assignmentId = await createWeekAssignment({ weekDateId: dateA.id, subject: 'Reading', title: 'Chapter 1', contentItemId: null });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignmentId}/move`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ weekDateId: otherDate.id, _csrf: csrf });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);

  const row = await db.prepare('SELECT week_date_id FROM family_school_week_assignments WHERE id = ?').get(assignmentId);
  assert.equal(row.week_date_id, dateA.id, 'the assignment must stay on its original date');
});

test('a week with assignments across subjects renders the subject percentage chart with the right percentages', async () => {
  const familyId = await createFamily('Chart Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Chart Week', dates: ['2026-11-23', '2026-11-24'], createdByAccountId: null });
  const [dateA, dateB] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(weekId);
  await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Fractions', contentItemId: null });
  await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Decimals', contentItemId: null });
  await createWeekAssignment({ weekDateId: dateB.id, subject: 'Reading', title: 'Chapter 2', contentItemId: null });
  await createWeekAssignment({ weekDateId: dateB.id, subject: '', title: 'Unlabeled task', contentItemId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /fs-weekly-plan-subject-chart/);
  assert.match(page.text, /Math[\s\S]*?50%/);
  assert.match(page.text, /Reading[\s\S]*?25%/);
  assert.match(page.text, /Other[\s\S]*?25%/);
});

test('a week with zero assignments shows "No assignments yet this week." and no chart', async () => {
  const familyId = await createFamily('Empty Chart Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Empty Week', dates: ['2026-12-07'], createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /No assignments yet this week\./);
  assert.doesNotMatch(page.text, /fs-weekly-plan-subject-chart/);
});

test('the grid renders drag handles and dropzones wired for public/js/weekly-planner-dragdrop.js', async () => {
  const familyId = await createFamily('Markup Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Markup Week', dates: ['2026-12-14', '2026-12-15'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(weekId);
  const assignmentId = await createWeekAssignment({ weekDateId: dateA.id, subject: 'Science', title: 'Experiment write-up', contentItemId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-week-date-id="${dateA.id}"`));
  assert.match(page.text, new RegExp(`data-assignment-id="${assignmentId}"`));
  assert.match(page.text, /data-assignment-drag-handle/);
  assert.match(page.text, /<script src="\/js\/weekly-planner-dragdrop\.js"><\/script>/);
});
