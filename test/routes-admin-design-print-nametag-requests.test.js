// Coverage for the Design/Print hub's Print tab "Name Tag Requests" option
// - a real request: "printing, add a dropdown choice called name tag
// requests. when you choose this option it will show the names of the
// people currently on the nametag request log that need to be printed."
// Reuses the exact same /admin/name-tag/print bulk-print flow the Name
// Tags option already uses, just pre-filtered to members with a still-
// open (unarchived) request (routes/admin-design.js's own
// pendingNameTagRequests) - one row per member, not per request, so a
// member with more than one open request doesn't get duplicate checkboxes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-design-print-nametag-requests-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-design-print-nametag-requests-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

test('Name Tag Requests option shows an empty message when there are no open requests', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No name tag requests need printing right now\./);
});

test('Print tab offers a "Name Tag Requests" option listing only members with an open request', async () => {
  const cookie = await loginAsAdmin();

  const { lastInsertRowid: lostTagMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Riley Lost Tag', 'Riley Lost Tag', 'student')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'left it at home')").run(lostTagMemberId);

  const { lastInsertRowid: bothRequestsMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Casey Two Requests', 'Casey Two Requests', 'parent')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'schedule_change', 'wednesday', 'new schedule')").run(bothRequestsMemberId);
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'wednesday', 'lost it too')").run(bothRequestsMemberId);

  const { lastInsertRowid: archivedMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Morgan Already Printed', 'Morgan Already Printed', 'student')")
    .run();
  await db
    .prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description, archived) VALUES (?, 'lost_tag', 'monday', 'done', 1)")
    .run(archivedMemberId);

  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="nameTagRequests">Name Tag Requests<\/option>/);

  // Casey/Riley/Morgan are also real active members, so they legitimately
  // appear once each in the OTHER print panels' full member-picker lists
  // (Schedule Cards, etc.) too - scope these assertions to just the Name
  // Tag Requests section's own table, not the whole page.
  const section = /<div id="print-nameTagRequests-section"[\s\S]*?<\/table>/.exec(res.text)[0];
  assert.match(section, /Riley Lost Tag/);
  assert.match(section, /Casey Two Requests/);
  // A member with two open requests gets exactly one row/checkbox, not two.
  assert.equal((section.match(/Casey Two Requests/g) || []).length, 1);
  assert.match(section, /Lost Name Tag, Schedule Change/);
  // An already-archived (already printed) request should not show up here.
  assert.doesNotMatch(section, /Morgan Already Printed/);
});

test('the Name Tag Requests picker submits to the same bulk /admin/name-tag/print flow', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jamie Print Me', 'Jamie Print Me', 'student')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'monday', 'never had one')").run(memberId);

  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post('/admin/name-tag/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(memberId), _csrf: csrfToken });
  assert.equal(res.status, 200);
  assert.match(res.text, /Jamie Print Me/);
});
