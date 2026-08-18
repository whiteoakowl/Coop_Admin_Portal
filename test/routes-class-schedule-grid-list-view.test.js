// A real user request: "On the class schedule page add two buttons,
// grid view and list view, these are simply small square icon buttons.
// When you click list view it shows all of the classes in alphabetical
// order. You can still see the Wednesday/Monday pill toggle and a
// dropdown menu for choosing what hour to view." Covers views/partials/
// class-schedule-grid.ejs's new list-view table (flattened from the
// same roomGrid data the grid view already uses, alphabetized by class
// name) and its Hour filter <select> - client-side behavior (public/js/
// class-schedule-view-toggle.js) is verified live via Playwright
// separately; this is the server-rendered markup it operates on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-grid-list-view-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-grid-list-view-test-uploads-${process.pid}`);
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

test('the list view lists every class alphabetically, and the day pill/hour dropdown/view buttons are all present', async () => {
  const cookie = await loginAsAdmin();

  await createClass({ day: 'monday', hourPosition: 2, className: 'Zebra Studies', room: 'Room A' });
  await createClass({ day: 'monday', hourPosition: 1, className: 'Art Basics', room: 'Room B' });
  await createClass({ day: 'monday', hourPosition: 1, className: 'Math Explorers', room: 'Room C' });

  const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // Monday/Wednesday pill toggle still there.
  assert.match(res.text, /schedule-day-toggle/);
  assert.match(res.text, />Monday<\/a>/);
  assert.match(res.text, />Wednesday<\/a>/);

  // The Grid/List view toggle buttons and the Hour filter dropdown.
  assert.match(res.text, /data-class-schedule-view-btn="grid"/);
  assert.match(res.text, /data-class-schedule-view-btn="list"/);
  assert.match(res.text, /data-class-schedule-hour-filter="monday"/);
  assert.match(res.text, /All Hours/);

  // Both view panels present, list starts hidden (Grid is the default).
  assert.match(res.text, /data-class-schedule-view="grid" data-class-schedule-day="monday"/);
  assert.match(res.text, /data-class-schedule-view="list" data-class-schedule-day="monday" hidden/);

  // The list table's rows are in alphabetical order, not creation/hour order.
  const nameCol = /<td class="class-schedule-list-name-col">[^]*?<\/td>/g;
  const listNames = [...res.text.matchAll(nameCol)].map((m) => m[0].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(listNames, ['Art Basics', 'Math Explorers', 'Zebra Studies']);

  // Each list row carries its own hour position for the client-side hour filter.
  assert.match(res.text, /<tr data-class-schedule-hour="1">/);
  assert.match(res.text, /<tr data-class-schedule-hour="2">/);
});

test('an empty day shows "No classes yet." in the list view too, not just the grid', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const listSection = res.text.slice(res.text.indexOf('data-class-schedule-view="list"'));
  assert.match(listSection, /No classes yet\./);
});
