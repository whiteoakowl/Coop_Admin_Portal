// Regression coverage for a mobile bug report: the class roster toolbar
// (+ Add Member / Import / Export / Print / Allergies-Medical) used to sit
// at the very bottom of the class View/Edit popup, after both the
// Teachers & Assistants and Student Roster lists - on mobile (where the
// dialog's two columns stack instead of sitting side by side) that meant
// scrolling past the whole edit form AND both rosters just to reach it.
// It now sits right above Teachers & Assistants instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-view-fragment-toolbar-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-view-fragment-toolbar-test-uploads-${process.pid}`);
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

test('the class view fragment lists the roster toolbar before Teachers & Assistants, not after Student Roster', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Toolbar Order Test Class' });

  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);

  const toolbarIndex = res.text.indexOf('class-view-roster-actions');
  const teachersIndex = res.text.indexOf('Teachers &amp; Assistants');
  const studentRosterIndex = res.text.indexOf('Student Roster');

  assert.ok(toolbarIndex !== -1, 'expected to find the roster toolbar');
  assert.ok(teachersIndex !== -1, 'expected to find the Teachers & Assistants heading');
  assert.ok(studentRosterIndex !== -1, 'expected to find the Student Roster heading');
  assert.ok(toolbarIndex < teachersIndex, 'the roster toolbar should come before Teachers & Assistants');
  assert.ok(toolbarIndex < studentRosterIndex, 'the roster toolbar should come before Student Roster');

  // Exactly one toolbar in the fragment - not left duplicated at the
  // bottom after being added at the top.
  assert.equal(res.text.split('class-view-roster-actions').length - 1, 1, 'the toolbar markup should only appear once');
});
