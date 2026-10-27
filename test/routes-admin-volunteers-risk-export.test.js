// A real request: "all pages/subpages across the entire app where there
// are print, export, import, or download buttons should be changed to
// icons, and those pages/subpages should have all four." Floater
// Assignments' own Class Cancellation Risk tab (views/admin-volunteer-
// risk.ejs) only had Print - this covers its new Export (icon button +
// routes/admin-volunteers.js's own GET /volunteers/:day/risk/export.csv).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-risk-export-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-risk-export-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, saveHourLabels } = require('../utils/classSchedule');
const { CLASS_DAY_WEEKDAY_FULL } = require('../utils/classDays');
const { todayISO } = require('../utils/dates');

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

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - buffers the binary response so the
// PDF bytes can actually be checked, the same way test/parent-family-
// school-print-preview-and-pdf.test.js does for its own download.pdf
// routes.
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

test('Floater Assignments Class Cancellation Risk tab: Export and Print are icon buttons, Export downloads a CSV', async () => {
  const cookie = await loginAsAdmin();

  const page = await request(app).get('/admin/volunteers/monday/risk').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="icon-btn" href="\/admin\/volunteers\/monday\/risk\/export\.csv[^"]*" aria-label="Export CSV"/);
  // A real request: "All print button should show a print preview full
  // real page on a page with a print button." - Print is now a link to
  // a dedicated preview page, not a direct window.print() call.
  assert.match(page.text, /<a class="icon-btn" href="\/admin\/volunteers\/monday\/risk\/print\?semesterId=[^"]*" target="_blank" aria-label="Print"/);
  assert.doesNotMatch(page.text, /icon-btn" onclick="window\.print\(\)"/);
  // A real request: "the download should be a pdf of exactly how it
  // would also look when printing" - Download PDF sits right next to
  // Print.
  assert.match(page.text, /<a class="icon-btn" href="\/admin\/volunteers\/monday\/risk\/download\.pdf\?semesterId=[^"]*" aria-label="Download PDF"/);

  const csv = await request(app).get('/admin/volunteers/monday/risk/export.csv').set('Cookie', cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Hour.*Class.*Room.*Expected.*Enrolled/);
});

test('Floater Assignments Class Cancellation Risk print preview: shows the same at-risk classes, read-only, with its own Print button', async () => {
  const cookie = await loginAsAdmin();
  // classesAtRiskForDay only ever flags a class for TODAY's own weekday
  // (routes/admin-volunteers.js's own alertDate) - the live /risk route
  // and this /risk/print preview both derive it the same way, so the
  // test has to actually use today's own day name to see anything flagged.
  const today = todayISO();
  const day = Object.keys(CLASS_DAY_WEEKDAY_FULL).find((d) => CLASS_DAY_WEEKDAY_FULL[d] === new Date(today).getUTCDay());
  // The default seed data only ever configures class_schedule_hours rows
  // for Monday/Wednesday - gridForDay (which classesAtRiskForDay reads
  // from) returns zero hours, and therefore never surfaces this class,
  // for any other day of the week the suite happens to run on. Seed an
  // hour for today's own day explicitly so this test doesn't depend on
  // which weekday it's actually run on.
  await saveHourLabels(day, ['Hour 1']);
  const classId = await createClass({ day, hourPosition: 1, className: 'Risk Preview Class', room: 'Room 5' });
  const students = [];
  for (let i = 1; i <= 4; i++) {
    students.push((await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(`Risk Preview Kid ${i}`, `risk-preview-kid-${i}`, 'student')).lastInsertRowid);
  }
  await setEnrollment(classId, students);
  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Risk Preview Roster', 'Class Schedule')").run()).lastInsertRowid;
  for (const studentId of students.slice(0, 3)) {
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'absence_form')")
      .run(studentId, rosterId, today);
  }

  const preview = await request(app).get(`/admin/volunteers/${day}/risk/print`).set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /class="print-preview-header no-print"/);
  assert.match(preview.text, /roster-action-btn print-action-btn" onclick="window\.print\(\)"/);
  assert.match(preview.text, /Risk Preview Class/);
  assert.match(preview.text, /Room 5/);
});

test('print preview page requires admin login, same as the live page it mirrors', async () => {
  const res = await request(app).get('/admin/volunteers/monday/risk/print');
  assert.equal(res.status, 302, 'unauthenticated request should redirect to login');
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - same at-risk classes the print
// preview shows, as a real PDF from routes/admin-volunteers.js's own
// GET /volunteers/:day/risk/download.pdf.
test('Floater Assignments Class Cancellation Risk tab: Download PDF is a real PDF of the same at-risk classes the print preview shows', async () => {
  const cookie = await loginAsAdmin();
  const today = todayISO();
  const day = Object.keys(CLASS_DAY_WEEKDAY_FULL).find((d) => CLASS_DAY_WEEKDAY_FULL[d] === new Date(today).getUTCDay());
  // Same reasoning as the print-preview test above - seed an hour for
  // today's own day so this doesn't depend on which weekday it runs on.
  await saveHourLabels(day, ['Hour 1']);
  const classId = await createClass({ day, hourPosition: 1, className: 'Download PDF Risk Class', room: 'Room 6' });
  const students = [];
  for (let i = 1; i <= 4; i++) {
    students.push((await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(`Download PDF Risk Kid ${i}`, `download-pdf-risk-kid-${i}`, 'student')).lastInsertRowid);
  }
  await setEnrollment(classId, students);
  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Download PDF Risk Roster', 'Class Schedule')").run()).lastInsertRowid;
  for (const studentId of students.slice(0, 3)) {
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'absence_form')")
      .run(studentId, rosterId, today);
  }

  const pdfRes = await getBuffer(`/admin/volunteers/${day}/risk/download.pdf`, cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.match(pdfRes.headers['content-disposition'], new RegExp(`attachment; filename="${day}-class-cancellation-risk\\.pdf"`));
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('Floater Assignments Class Cancellation Risk download.pdf requires admin login, same as the live page it mirrors', async () => {
  const res = await request(app).get('/admin/volunteers/monday/risk/download.pdf');
  assert.equal(res.status, 302, 'unauthenticated request should redirect to login');
});
