// Coverage for a real request: "PDF download icons should be added to
// every page across the app that has a print icon/button." Each of these
// pages already got a dedicated read-only <name>-print.ejs preview page
// earlier (its own Print button opens that preview in a new tab instead
// of calling window.print() directly) - this covers the matching
// Download PDF icon-btn + GET .../download.pdf route added alongside
// each one, built via utils/pdfRender.js's renderViewToPdf from that
// exact same -print.ejs view (see routes/parent-family-school.js's own
// download.pdf routes for the original version of this pattern).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-download-pdf-buttons-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-download-pdf-buttons-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

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

let teacherCounter = 0;
async function loginAsTeacher() {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('PDF Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  const email = `pdf-download-teacher-${teacherCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return loginRes.headers['set-cookie'];
}

// Buffers a binary response (a real PDF) instead of letting supertest try
// to decode it as text - same approach test/parent-family-school-print-
// preview-and-pdf.test.js already uses for its own Download PDF routes.
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

function assertRealPdf(res) {
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="[^"]+\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
}

test('Class Schedule day grid: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();
  await createClass({ day: 'monday', hourPosition: 1, className: 'PDF Button Class', room: 'Room 9' });

  const liveRes = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/class-schedule\/monday\/print" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/class-schedule\/monday\/download\.pdf" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/class-schedule/monday/download.pdf', cookie);
  assertRealPdf(pdfRes);
});

test('Class Roster: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'PDF Roster Class' });

  const liveRes = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.match(liveRes.text, new RegExp(`href="/admin/class-schedule/classes/${classId}/roster/print" target="_blank" aria-label="Print"`));
  assert.match(liveRes.text, new RegExp(`href="/admin/class-schedule/classes/${classId}/roster/download\\.pdf" aria-label="Download PDF"`));

  const pdfRes = await getBuffer(`/admin/class-schedule/classes/${classId}/roster/download.pdf`, cookie);
  assertRealPdf(pdfRes);

  const notFound = await getBuffer('/admin/class-schedule/classes/999999/roster/download.pdf', cookie);
  assert.equal(notFound.status, 404);
});

test('Rosters: Download PDF button + route for both the day/class grid and the Playground log', async () => {
  const cookie = await loginAsAdmin();

  const gridLive = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', cookie);
  assert.match(gridLive.text, /href="\/admin\/rosters\/print\?tab=monday-parent" target="_blank" aria-label="Print"/);
  assert.match(gridLive.text, /href="\/admin\/rosters\/download\.pdf\?tab=monday-parent" aria-label="Download PDF"/);

  const gridPdf = await getBuffer('/admin/rosters/download.pdf?tab=monday-parent', cookie);
  assertRealPdf(gridPdf);

  const pgLive = await request(app).get('/admin/rosters?tab=playground-monday-1').set('Cookie', cookie);
  assert.match(pgLive.text, /href="\/admin\/rosters\/download\.pdf\?tab=playground-monday-1" aria-label="Download PDF"/);

  const pgPdf = await getBuffer('/admin/rosters/download.pdf?tab=playground-monday-1', cookie);
  assertRealPdf(pgPdf);

  const notFound = await getBuffer('/admin/rosters/download.pdf?tab=class-999999', cookie);
  assert.equal(notFound.status, 404);
});

test('Class Registration Log: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();

  const liveRes = await request(app).get('/admin/schedule?tab=classregistrationlog').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/schedule\/classregistrationlog\/print" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/schedule\/classregistrationlog\/download\.pdf" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/schedule/classregistrationlog/download.pdf', cookie);
  assertRealPdf(pdfRes);
});

test('Member Schedules list: Download PDF button + route (also linked from Member Profile and the Schedule dialog)', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('PDF Schedule Member', 'pdf-schedule-member', 'parent', 1) RETURNING id").get()).id;

  const liveRes = await request(app).get('/admin/schedule?tab=members').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/schedule\/print[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/schedule\/download\.pdf[^"]*" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/schedule/download.pdf', cookie);
  assertRealPdf(pdfRes);

  const memberPdf = await getBuffer(`/admin/schedule/download.pdf?memberId=${memberId}`, cookie);
  assertRealPdf(memberPdf);

  const profileRes = await request(app).get(`/admin/members/${memberId}?tab=schedule`).set('Cookie', cookie);
  assert.match(profileRes.text, new RegExp(`href="/admin/schedule/download\\.pdf\\?memberId=${memberId}" aria-label="Download PDF"`));
});

test('Setup/Cleanup Teams: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();

  const liveRes = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/teams\/print\?semesterId=[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/teams\/download\.pdf\?semesterId=[^"]*" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/setup/monday/teams/download.pdf', cookie);
  assertRealPdf(pdfRes);
});

test('Setup/Cleanup Assignments: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();

  const liveRes = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/assignments\/print\?semesterId=[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/assignments\/download\.pdf\?semesterId=[^"]*" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/setup/monday/assignments/download.pdf', cookie);
  assertRealPdf(pdfRes);
});

test('Setup/Cleanup Task List: Download PDF button + route', async () => {
  const cookie = await loginAsAdmin();

  const liveRes = await request(app).get('/admin/setup/monday/tasks').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/tasks\/print\?semesterId=[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/admin\/setup\/monday\/tasks\/download\.pdf\?semesterId=[^"]*" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/admin/setup/monday/tasks/download.pdf', cookie);
  assertRealPdf(pdfRes);
});

test('Teacher Portal Classes: Download PDF button + route', async () => {
  const cookie = await loginAsTeacher();
  await createClass({ day: 'monday', hourPosition: 1, className: 'Teacher PDF Class', room: 'Room 3' });

  const liveRes = await request(app).get('/teacher/classes?view=grid&day=monday').set('Cookie', cookie);
  assert.match(liveRes.text, /href="\/teacher\/classes\/print\?day=monday&view=grid[^"]*" target="_blank" aria-label="Print"/);
  assert.match(liveRes.text, /href="\/teacher\/classes\/download\.pdf\?day=monday&view=grid[^"]*" aria-label="Download PDF"/);

  const pdfRes = await getBuffer('/teacher/classes/download.pdf?day=monday&view=grid', cookie);
  assertRealPdf(pdfRes);
});
