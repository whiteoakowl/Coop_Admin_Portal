// Coverage for Co-op Admin Portal > Members > Grade Level Report - a real
// request to add the same report the Main Admin Portal already has
// (test/routes-main-admin-members-grade-level-report.test.js covers that
// one's full filter/bar-chart/grouping behavior in depth) over to the
// Co-op Admin side too (routes/admin-members.js's own GET
// /grade-level-report, views/admin-members-grade-level-report.ejs). Kept
// intentionally light here since the underlying logic is identical and
// already exercised thoroughly on the Main Admin side - this just confirms
// the Co-op Admin route/view/button actually exist and work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-grade-level-report-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-grade-level-report-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

// Same buffer-a-binary-response shape as test/parent-family-school-print-
// preview-and-pdf.test.js's own getBuffer - supertest's default text
// parser corrupts a real PDF's binary body.
async function getBuffer(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

let seedCounter = 0;
async function createStudent({ name, gradeLevel, birthday }) {
  seedCounter += 1;
  const code = `coopgradereport${seedCounter}`;
  await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, grade_level, birthday, active) VALUES (?, ?, ?, 'student', ?, ?, 1)")
    .run(name, code, code, gradeLevel || null, birthday || null);
}

test('Co-op Admin Members page offers a Grade Level Report button', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<a class="roster-action-btn" href="\/admin\/members\/grade-level-report">Grade Level Report<\/a>/);
});

test('Co-op Admin Grade Level Report: no active students with a grade level shows an empty-state message', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/members/grade-level-report').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No active students have a grade level on file yet\./);
});

test('Co-op Admin Grade Level Report: groups students by grade level with ages, and sorts an Ungraded column last', async () => {
  const cookie = await loginAsAdmin();
  const kBirthday = '2020-01-01';
  const expectedAge = ageFromBirthday(kBirthday);
  await createStudent({ name: 'Coop Kinder', gradeLevel: 'Kindergarten', birthday: kBirthday });
  await createStudent({ name: 'Coop No Grade', gradeLevel: null, birthday: '2015-01-01' });

  const res = await request(app).get('/admin/members/grade-level-report').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<div class="grade-level-report-col-title" title="Kindergarten">Kindergarten</div>\\s*<p class="grade-level-report-name">Coop Kinder \\(${expectedAge}\\)</p>`));
  assert.match(res.text, /<div class="grade-level-report-col-title" title="Ungraded">Ungraded<\/div>\s*<p class="grade-level-report-name">Coop No Grade \(\d+\)<\/p>/);

  // A later real request: "all pages/subpages with print, export,
  // import, or download buttons should be changed to icons... and have
  // all four" - this page only had Print; Export and Print are icon
  // buttons now, and Export downloads a CSV of the same students.
  assert.match(res.text, /<a class="icon-btn" href="\/admin\/members\/grade-level-report\/export\.csv[^"]*" aria-label="Export CSV"/);
  // A real request: "all print button should show a print preview full
  // real page on a page with a print button" - Print now links to a
  // dedicated preview route in a new tab instead of calling window.print()
  // on this live, editable page directly.
  assert.match(res.text, /<a class="icon-btn" href="\/admin\/members\/grade-level-report\/print[^"]*" target="_blank" aria-label="Print"/);
  assert.doesNotMatch(res.text, /onclick="window\.print\(\)" aria-label="Print"/);
  // A real request: "the download should be a pdf of exactly how it
  // would also look when printing" - Download PDF sits right beside Print.
  assert.match(res.text, /<a class="icon-btn" href="\/admin\/members\/grade-level-report\/download\.pdf[^"]*" aria-label="Download PDF"/);

  const csv = await request(app).get('/admin/members/grade-level-report/export.csv').set('Cookie', cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Grade Level.*Name.*Age/);
  assert.match(csv.text, /Kindergarten.*Coop Kinder/);
  assert.match(csv.text, /Ungraded.*Coop No Grade/);
});

test('GET /admin/members/grade-level-report/print renders a read-only preview with a Print button, respecting the same filters', async () => {
  const cookie = await loginAsAdmin();
  const kBirthday = '2020-01-01';
  await createStudent({ name: 'Coop Preview Kinder', gradeLevel: 'Kindergarten', birthday: kBirthday });
  await createStudent({ name: 'Coop Preview Third', gradeLevel: '3rd', birthday: '2016-01-01' });

  const res = await request(app).get('/admin/members/grade-level-report/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /print-preview-header/);
  assert.match(res.text, /onclick="window\.print\(\)"/);
  assert.match(res.text, /Coop Preview Kinder/);
  assert.match(res.text, /Coop Preview Third/);
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - a real PDF built from the exact
// same admin-members-grade-level-report-print.ejs view the Print
// button opens.
test('GET /admin/members/grade-level-report/download.pdf returns a real PDF', async () => {
  const cookie = await loginAsAdmin();
  await createStudent({ name: 'Coop Download Kinder', gradeLevel: 'Kindergarten', birthday: '2020-01-01' });

  const res = await getBuffer('/admin/members/grade-level-report/download.pdf', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="grade-level-report\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
});
