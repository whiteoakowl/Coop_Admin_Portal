// Coverage for a real bug report: "if I add an assignment to a class when
// I save it says something went wrong." Traced to views/partials/lesson-
// content-manage.ejs's "Add Assignments" form: every content-type
// section (video/text/file/quiz/assignment_upload) stays in the DOM at
// once (CSS display:none hides whichever ones don't match the selected
// Type - see public/js/lesson-content-form.js - nothing is ever removed
// from the form), and two pairs of fields used to share a name across
// those sections: video's and file's "Description" both named
// `description`, and text's textarea and assignment_upload's rich-text
// hidden input both named `body`. A real browser form submission sends
// every field regardless of which type is selected, and a same-named
// pair becomes a 2-element ARRAY server-side (Express's urlencoded body
// parser) - routes/admin-class-schedule.js's (and routes/teacher-
// portal.js's identical) POST handler called .trim() or
// sanitizePostBody() on that array expecting a string, throwing
// regardless of which type was actually chosen. A plain supertest
// `.send({ ... })` object can only ever hold one value per key, so it
// can't reproduce this - these tests post a raw urlencoded body with the
// field repeated, the same shape a real HTML form with two same-named
// inputs actually sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-content-dup-field-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-content-dup-field-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createAssignment, contentItemsForAssignment } = require('../utils/academics');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let classCounter = 0;
async function createClassAndAssignment() {
  classCounter += 1;
  const classId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES (?, 'monday', 1) RETURNING id").get(`Dup Field Test Class ${classCounter}`)
  ).id;
  const assignmentId = await createAssignment({ classId, className: `Dup Field Test Class ${classCounter}`, title: 'Lesson', createdByAccountId: null });
  return { classId, assignmentId };
}

test('Adding a "Text Description" assignment no longer 500s when the form\'s duplicate body fields are both submitted (real browser shape)', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();

  // Mirrors the real (fixed) form: type=text selected, with every other
  // type's fields also present and empty, exactly as a real browser
  // sends them regardless of which type's section is visible - but,
  // post-fix, each field name now appears only once.
  const res = await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(
      `type=text&title=${encodeURIComponent('My Text Lesson')}&description=&fileDescription=&body=${encodeURIComponent('<p>Hello class</p>')}&fileUrl=&videoUrl=&assignmentBody=&_csrf=${encodeURIComponent(admin.csrfToken)}`
    );

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /notice=Assignment added/);

  const items = await contentItemsForAssignment(assignmentId, { includeAnswerKey: false });
  const added = items.find((i) => i.type === 'text');
  assert.ok(added, 'expected a text content item to have been created');
  assert.match(added.body, /Hello class/);
});

test('Adding an "Assignment Upload" assignment no longer 500s when the form\'s duplicate body fields are both submitted', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();

  const res = await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(
      `type=assignment_upload&title=${encodeURIComponent('My Upload Lesson')}&description=&fileDescription=&body=&assignmentBody=${encodeURIComponent('<p>Write an essay</p>')}&fileUrl=&videoUrl=&_csrf=${encodeURIComponent(admin.csrfToken)}`
    );

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /notice=Assignment added/);

  const items = await contentItemsForAssignment(assignmentId, { includeAnswerKey: false });
  const added = items.find((i) => i.type === 'assignment_upload');
  assert.ok(added, 'expected an assignment_upload content item to have been created');
  assert.match(added.body, /Write an essay/);
});

test('Adding a "Link to Video" assignment no longer 500s when the form\'s duplicate description fields are both submitted', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();

  const res = await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(
      `type=video&title=${encodeURIComponent('My Video Lesson')}&videoUrl=${encodeURIComponent('https://example.com/video')}&description=${encodeURIComponent('A great video')}&fileDescription=&body=&assignmentBody=&fileUrl=&_csrf=${encodeURIComponent(admin.csrfToken)}`
    );

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /notice=Assignment added/);

  const items = await contentItemsForAssignment(assignmentId, { includeAnswerKey: false });
  const added = items.find((i) => i.type === 'video');
  assert.ok(added, 'expected a video content item to have been created');
  assert.equal(added.description, 'A great video');
});

test('Adding a "Link to File" assignment no longer 500s when the form\'s duplicate description fields are both submitted', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();

  const res = await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(
      `type=file&title=${encodeURIComponent('My File Lesson')}&fileUrl=${encodeURIComponent('https://example.com/file.pdf')}&description=&fileDescription=${encodeURIComponent('A great file')}&body=&assignmentBody=&videoUrl=&_csrf=${encodeURIComponent(admin.csrfToken)}`
    );

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /notice=Assignment added/);

  const items = await contentItemsForAssignment(assignmentId, { includeAnswerKey: false });
  const added = items.find((i) => i.type === 'file');
  assert.ok(added, 'expected a file content item to have been created');
  assert.equal(added.description, 'A great file');
});
