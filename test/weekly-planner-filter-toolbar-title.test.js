// Coverage for a real follow-up request on the Weekly Planner (see
// weekly-planner-dragdrop-and-subject-chart.test.js's own header
// comment for this subpage's full history): "Add a filter button.
// Choose student, choose school year and choose week. Remove plan for
// dropdown of student choice. Print, pdf and export icon to the left,
// adequate space between rows. Orange filter and add week button on
// same row to the right... Week 1 title on the title bar of week
// schedule."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `weekly-planner-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `weekly-planner-filter-test-uploads-${process.pid}`);
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
  const code = `wpft${counter}`;
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
  return { cookie: loginRes.headers['set-cookie'] };
}

test('the old standalone "Plan for" dropdown is gone - the Filter popover has Student/School Year/Week instead', async () => {
  const familyId = await createFamily('No Plan For Family');
  const parent = await createParent(familyId);

  const page = await request(app).get('/parent/family-school/weekly-planner').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, />Plan for</);
  assert.doesNotMatch(page.text, /id="weekly-planner-owner-select"[^>]*onchange/, 'the student select moved into the Filter popover and no longer auto-submits on its own');
  assert.match(page.text, /<summary class="roster-action-btn">Filter<\/summary>/);
  assert.match(page.text, /id="weekly-planner-owner-select"/);
  assert.match(page.text, /id="weekly-planner-school-year-select"/);
  assert.match(page.text, /id="weekly-planner-week-select"/);
});

// A later real request ("all pages filter button first, all import,
// export, pdf and print icons should be in a row next to each other...
// placed to the left") reordered this toolbar: Filter now comes first,
// then the icons, then + Add Week, all in one single row.
test('Filter, the Print/PDF/Export icons, and + Add Week all sit together on one row, in that order', async () => {
  const familyId = await createFamily('Toolbar Order Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Order Week', dates: ['2026-11-02'], createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  const filterIndex = page.text.indexOf('<summary class="roster-action-btn">Filter</summary>');
  const exportIndex = page.text.indexOf('aria-label="Export CSV"');
  const printIndex = page.text.indexOf('aria-label="Print"');
  const pdfIndex = page.text.indexOf('aria-label="Download PDF"');
  const addWeekIndex = page.text.indexOf('+ Add Week');
  assert.ok(filterIndex > -1 && exportIndex > filterIndex, 'expected Filter before the icons');
  assert.ok(printIndex > exportIndex && pdfIndex > printIndex, 'expected Export, then Print, then PDF');
  assert.ok(addWeekIndex > pdfIndex, 'expected + Add Week after the icons');

  // A real request: "Weeks are blue buttons. Delete the blue buttons."
  assert.doesNotMatch(page.text, /class="btn-secondary active"/);
  assert.doesNotMatch(page.text, /class="btn-secondary" href="\?owner=/);
});

test('the selected week\'s own title shows in the page title bar', async () => {
  const familyId = await createFamily('Title Bar Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Week 1', dates: ['2026-11-09'], createdByAccountId: null });

  const noWeekPage = await request(app).get('/parent/family-school/weekly-planner?owner=parent').set('Cookie', parent.cookie);
  assert.match(noWeekPage.text, /<h1>Weekly Planner<\/h1>/);

  const weekPage = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(weekPage.text, /<h1>Weekly Planner &mdash; Week 1<\/h1>/);
});

test('the School Year filter narrows which weeks show in the Filter\'s own Week dropdown', async () => {
  const familyId = await createFamily('School Year Filter Family');
  const parent = await createParent(familyId);
  const fallWeekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Fall Week', dates: ['2026-09-07'], createdByAccountId: null });
  const nextFallWeekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Next Fall Week', dates: ['2027-09-06'], createdByAccountId: null });

  const allYears = await request(app).get('/parent/family-school/weekly-planner?owner=parent').set('Cookie', parent.cookie);
  assert.match(allYears.text, /Fall Week/);
  assert.match(allYears.text, /Next Fall Week/);
  assert.match(allYears.text, /<option value="2026-2027"[^>]*>2026-2027<\/option>/);
  assert.match(allYears.text, /<option value="2027-2028"[^>]*>2027-2028<\/option>/);

  const filtered = await request(app).get('/parent/family-school/weekly-planner?owner=parent&schoolYear=2026-2027').set('Cookie', parent.cookie);
  assert.match(filtered.text, /Fall Week/);
  assert.doesNotMatch(filtered.text, /Next Fall Week/);
  void fallWeekId;
  void nextFallWeekId;
});

test('Export CSV downloads one row per assignment for the selected week', async () => {
  const familyId = await createFamily('Export CSV Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'CSV Week', dates: ['2026-11-16'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);
  await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Fractions', contentItemId: null, grade: 'A' });

  const res = await request(app).get(`/parent/family-school/weekly-planner/export.csv?weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /"Date","Subject","Title","Description","Link","Grade","Completed"/);
  assert.match(res.text, /"Math","Fractions"/);
  assert.match(res.text, /"A","No"/);
});

test('a parent from a different family cannot export another family\'s week', async () => {
  const familyId = await createFamily('CSV Owner Family');
  const owner = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Owner CSV Week', dates: ['2026-11-23'], createdByAccountId: null });

  const otherFamilyId = await createFamily('CSV Outsider Family');
  const outsider = await createParent(otherFamilyId);

  const res = await request(app).get(`/parent/family-school/weekly-planner/export.csv?weekId=${weekId}`).set('Cookie', outsider.cookie);
  assert.equal(res.status, 404);
  void owner;
});
