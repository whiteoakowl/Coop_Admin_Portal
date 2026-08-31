// Two real bug reports, same fix: "co-op admin portal, wednesday/Monday
// attendance. allergy medical should fit inside its button nicely width
// wise. keep buttons the same height" and "setup cleanup buttons, mobile
// viee. should have the same shortened height as buttons on other pages.
// these buttons should be able to fit on one row. text fits in button
// nicely." Both toolbars inherited .roster-btn-row's shared mobile
// equal-width grid (public/js/roster-btn-row-grid.js), which wraps a
// long label ("Allergies/Medical", "+ Create New Team") onto multiple
// lines and stretches that row's height past its neighbors - the exact
// same bug the Class Edit popup's own roster toolbar was already fixed
// for earlier in this session. styles.css's own "roster-btn-row-fit-text"
// class (a real, reusable second class any .roster-btn-row toolbar can
// add) switches to auto-width, single-line, equal-HEIGHT buttons
// instead - this covers every toolbar it was added to actually carrying
// the class in its rendered markup. The visual behavior itself (equal
// height, no text wrap, no forced equal width) was verified live via
// Playwright screenshots - this suite has no browser/CSS layout harness,
// so it can only assert the markup wiring is present.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `roster-btn-row-fit-text-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `roster-btn-row-fit-text-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const { createClass } = require('../utils/classSchedule');

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

test('Attendance page toolbar (Allergies/Medical) carries the fit-text class', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text"/);
  assert.match(res.text, /Allergies\/Medical/);
});

test('Setup/Cleanup Teams tab toolbar carries the fit-text class', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text"/);
});

test('Setup/Cleanup Assignments tab toolbar carries the fit-text class, and Edit Dates matches every other button\'s class', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text"/);
  assert.match(
    res.text,
    /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('edit-dates-dialog'\)\.showModal\(\)">Edit Dates<\/button>/,
    'Edit Dates should use roster-action-btn like its siblings, not a mismatched btn-secondary that stretches the whole row taller'
  );
});

test('Setup/Cleanup Task List tab toolbar carries the fit-text class', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/setup/monday/tasks').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text"/);
});

test('the Class Edit popup roster toolbar still carries both its old class-view-roster-actions identifier and the new fit-text class', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Fit Text Verify Class' });
  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text class-view-roster-actions"/);
});
