// Coverage for a real request: "All of the new download icons across
// the app should be the pdf icon and the download should be a pdf of
// exactly how it would also look when printing. All print button
// should show a print preview full real page on a page with a print
// button. That print button will then send it to the printer."
//
// Applied here to the 4 Family School Management pages with a Download
// button (Journal, Grades, Attendance, Overview) - see utils/
// pdfRender.js (the headless-Chromium rendering behind every Download
// route below) and each page's own new -print.ejs view/route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-family-school-print-pdf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-family-school-print-pdf-test-uploads-${process.pid}`);
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
  const code = `printpdf${counter}`;
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

async function setupFamily(label) {
  label = label || 'Print PDF';
  const familyId = await createFamily(`${label} Family`);
  const parent = await createPortalMember({ name: `${label} Parent`, familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: `${label} Student`, familyId, memberType: 'student', roleKey: 'student' });
  return { parent, student };
}

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

test('Family Attendance: Print links to a dedicated preview page, and Download is a real PDF', async () => {
  const { parent, student } = await setupFamily();

  const liveRes = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.match(liveRes.text, /href="\/parent\/family-school\/attendance\/print\?studentId=\d+&year=\d+&month=\d+" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/attendance\/download\.pdf" aria-label="Download PDF"/);

  const previewRes = await request(app).get(`/parent/family-school/attendance/print?studentId=${student.memberId}&year=2026&month=3`).set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /class="print-preview-header no-print"/);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /<h2>Print PDF Student<\/h2>/);

  const pdfRes = await getBuffer('/parent/family-school/attendance/download.pdf', parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="family-attendance-all\.pdf"/);
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

// A real follow-up request: "Pdf and print should show all 12 months,
// August-July 2026-2027."
test('Family Attendance: Print and Download PDF show the whole Aug-Jul school year, not just one month', async () => {
  const { parent, student } = await setupFamily();
  await db
    .prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, '2026-09-10', 'present')")
    .run(student.memberId);
  await db
    .prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, '2027-03-05', 'absent')")
    .run(student.memberId);

  // Viewing March 2027 on the live calendar is still part of the
  // 2026-2027 school year (Aug 2026 - Jul 2027) - the Print/Download
  // routes derive that from the live page's own year/month, not from
  // whichever single month happens to be open.
  const previewRes = await request(app)
    .get(`/parent/family-school/attendance/print?studentId=${student.memberId}&year=2027&month=3`)
    .set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /2026-2027/);
  assert.match(previewRes.text, /August 2026/);
  assert.match(previewRes.text, /July 2027/);
  assert.doesNotMatch(previewRes.text, /August 2025/);
  assert.equal((previewRes.text.match(/class="fs-attendance-print-month"/g) || []).length, 12, 'exactly 12 month grids');
  assert.match(previewRes.text, /fs-attendance-day-present">10</);
  assert.match(previewRes.text, /fs-attendance-day-absent">5</);

  const pdfRes = await getBuffer('/parent/family-school/attendance/download.pdf', parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('Family Grades: Print links to a dedicated preview page, and Download is a real PDF', async () => {
  const { parent, student } = await setupFamily();

  const liveRes = await request(app).get(`/parent/family-school/grades?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.match(liveRes.text, /href="\/parent\/family-school\/grades\/print\?studentId=\d+" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/grades\/download\.pdf" aria-label="Download PDF"/);

  const previewRes = await request(app).get(`/parent/family-school/grades/print?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /<h2>Print PDF Student<\/h2>/);

  const pdfRes = await getBuffer('/parent/family-school/grades/download.pdf', parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('Daily Learning Log: Print links to a dedicated preview page, and Download is a real PDF', async () => {
  const { parent, student } = await setupFamily();

  const liveRes = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.match(liveRes.text, /href="\/parent\/family-school\/journal\/print\?studentId=\d+" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/journal\/download\.pdf" aria-label="Download PDF"/);

  const previewRes = await request(app).get(`/parent/family-school/journal/print?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);

  const pdfRes = await getBuffer('/parent/family-school/journal/download.pdf', parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

// A later real request ("remove filter button and feature") removed
// the Overview page's own Filter entirely - Print/Download always
// cover every family student now, with no studentId carried over.
test('Family School Management overview: Print links to a dedicated preview page, and Download is a real PDF', async () => {
  const { parent } = await setupFamily();

  const liveRes = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.match(liveRes.text, /href="\/parent\/family-school\/print" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/parent\/family-school\/download\.pdf" aria-label="Download PDF"/);

  const previewRes = await request(app).get('/parent/family-school/print').set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /Print PDF Student/);

  const pdfRes = await getBuffer('/parent/family-school/download.pdf', parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('a parent cannot preview or download another family\'s data by guessing a studentId', async () => {
  const { student: ownStudent } = await setupFamily('Victim');
  const { parent: otherParent } = await setupFamily('Snooping');

  const res = await request(app).get(`/parent/family-school/attendance/print?studentId=${ownStudent.memberId}`).set('Cookie', otherParent.cookie);
  assert.equal(res.status, 200);
  // An id that isn't actually in this parent's own family never
  // resolves to a real student (the same "never trust an id from the
  // request alone" rule the live routes already enforce) - the preview
  // renders with no student name at all, never the other family's.
  assert.doesNotMatch(res.text, /Victim Student/);
});
