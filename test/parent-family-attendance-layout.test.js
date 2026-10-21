// A real request: "Parent portal, family attendance. Present and absent
// keys should be to the left, not centered and just under the title.
// The description goes under the key bubbles. Then the orange buttons.
// Then the blue arrow buttons that should be shrunk a lot and the month
// should be a drop down choice of months/years. Move this row to the
// left. Mobile." (views/parent-family-school-attendance.ejs,
// routes/parent-family-school.js's own month/year <select> options).
//
// A later real request reordered this again: "Click a date description
// should be under title. Green and red bubble key under the description
// on the next row. Next row prev arrow button, month, year, and next
// button, all on the same row. Export, download and print icons on the
// last row." - description, then legend, then the month nav row, then
// the orange Export/Print/Download/Filter row right before the
// calendar (the opposite order of the request just above - see that
// section's own comment in the view for why).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-family-attendance-layout-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-family-attendance-layout-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

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
  const code = `attlayout${counter}`;
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
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

test('the description, legend row, month navigation, and orange buttons render in the requested order, each left-aligned', async () => {
  const familyId = await createFamily('Attendance Layout Family');
  const parent = await createPortalMember({ name: 'Layout Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Layout Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&year=2026&month=3`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);

  const legendIdx = res.text.indexOf('fs-attendance-legend-present');
  const descriptionIdx = res.text.indexOf('Click a date to mark present');
  const exportIdx = res.text.indexOf('aria-label="Export CSV"');
  const navRowIdx = res.text.indexOf('fs-attendance-nav-row');
  const calendarIdx = res.text.indexOf('fs-attendance-calendar');

  assert.ok(legendIdx > -1 && descriptionIdx > -1 && exportIdx > -1 && navRowIdx > -1 && calendarIdx > -1, 'every section should be present');
  assert.ok(descriptionIdx < legendIdx, 'the description should come before the Present/Absent legend');
  assert.ok(legendIdx < navRowIdx, 'the legend should come before the month navigation row');
  assert.ok(navRowIdx < exportIdx, 'the month navigation row should come before the orange Export/Print/Download/Filter row');
  assert.ok(exportIdx < calendarIdx, 'the orange buttons should come right before the calendar itself');

  // Both the legend row and the nav row opt out of the mobile-centering
  // .roster-btn-row-fit-text normally applies (public/css/styles.css's
  // own .roster-btn-row-fit-text.fs-attendance-row-left override).
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text fs-attendance-row-left">\s*<span class="badge-pill fs-attendance-legend-present"/);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text fs-attendance-row-left fs-attendance-nav-row"/);

  // "The blue arrow buttons that should be shrunk a lot."
  assert.match(res.text, /class="btn-secondary fs-attendance-nav-btn" href="\?studentId=\d+&year=2026&month=2" aria-label="Previous month">&larr; Prev</);
  assert.match(res.text, /class="btn-secondary fs-attendance-nav-btn" href="\?studentId=\d+&year=2026&month=4" aria-label="Next month">Next &rarr;</);

  // "The month should be a drop down choice of months/years."
  assert.match(res.text, /<select name="month" aria-label="Month" onchange="this\.form\.submit\(\)">/);
  assert.match(res.text, /<option value="3" selected>March<\/option>/);
  assert.match(res.text, /<select name="year" aria-label="Year" onchange="this\.form\.submit\(\)">/);
  assert.match(res.text, /<option value="2026" selected>2026<\/option>/);

  // A real request, later corrected to a PDF icon: "all down[load]
  // icons across the app should be a puff [cloud] icon... it looks the
  // same as export" / "Should be a pdf. Pdf icon." - Export keeps
  // icon-download, Download gets its own distinct icon-pdf.
  assert.match(res.text, /aria-label="Export CSV"[^>]*><svg class="icon"><use href="#icon-download"\/>/);
  assert.match(res.text, /aria-label="Download PDF"[^>]*><svg class="icon"><use href="#icon-pdf"\/>/);
});

test('the year dropdown always includes the currently selected year, even an old one outside the default window', async () => {
  const familyId = await createFamily('Old Year Family');
  const parent = await createPortalMember({ name: 'Old Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Old Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&year=2015&month=6`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="2015" selected>2015<\/option>/);
});

test('picking a month from the dropdown navigates via a plain GET, reusing the existing year/studentId query params', async () => {
  const familyId = await createFamily('Jump Month Family');
  const parent = await createPortalMember({ name: 'Jump Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Jump Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app)
    .get('/parent/family-school/attendance')
    .query({ studentId: student.memberId, year: '2026', month: '9' })
    .set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="9" selected>September<\/option>/);
  assert.match(res.text, new RegExp(`<input type="hidden" name="studentId" value="${student.memberId}" />`));
});
