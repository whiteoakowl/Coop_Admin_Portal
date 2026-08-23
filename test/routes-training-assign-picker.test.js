// Real HTTP-level coverage for two real requests on the Assign Training
// page (routes/admin-training.js's /assign route, views/admin-training-
// assign.ejs): "when assinging training to members it should be in
// alphabetical order according to last name. should have a filter option
// like bulk printing. primary parents, parents, students, admins" plus
// the follow-up "also select all and select none should be an option"
// and "also add filter option for training for teachers". Mirrors the
// Design/Print hub's own bulk print picker interaction (public/js/
// design-print-hub.js's wireBulkMemberList) via a standalone script
// (public/js/training-assign-picker.js) - this proves the SERVER side of
// that: correct last-name ordering and correct per-row data-type/
// data-primary/data-teacher attributes for that script to filter on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `training-assign-picker-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `training-assign-picker-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const T = require('../utils/training');
const { createClass, addStaff } = require('../utils/classSchedule');

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

test('Assign Training page: members are sorted by last name, and the filter/select-all UI is present', async (t) => {
  const cookie = await loginAsAdmin();
  const trainingId = await T.createTraining({ title: 'Filter Order Training', passingScore: 80, sequentialLessons: false });
  await T.createLesson(trainingId, { title: 'Read Me', type: 'text', content: 'x', required: true });

  // Deliberately out of first-name order but IN last-name order, so a
  // plain first-name sort (the old, wrong behavior) would read
  // differently than a real last-name sort.
  const zed = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Zed Anderson', 'Zed Anderson', 'parent')").run()).lastInsertRowid;
  const amy = (await db.prepare("INSERT INTO members (name, barcode, member_type, is_primary_parent) VALUES ('Amy Baxter', 'Amy Baxter', 'parent', 1)").run()).lastInsertRowid;
  const kid = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Kim Carter', 'Kim Carter', 'student')").run()).lastInsertRowid;
  const adm = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sam Diaz', 'Sam Diaz', 'admin')").run()).lastInsertRowid;
  const teacherId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bea Everly', 'Bea Everly', 'parent')").run()).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Picker Test Class' });
  await addStaff(classId, teacherId, 'teacher');

  const res = await request(app).get(`/admin/training/${trainingId}/assign`).set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('members appear in last-name order: Anderson, Baxter, Carter, Diaz, Everly', () => {
    const positions = [zed, amy, kid, adm, teacherId].map((id) => res.text.indexOf(`value="${id}"`));
    assert.ok(positions.every((p) => p !== -1), 'every seeded member should be in the picker');
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'expected Zed Anderson, Amy Baxter, Kim Carter, Sam Diaz, Bea Everly in that order');
  });

  await t.test('the filter dropdown offers All/Students/Primary Parents/Parents/Admins/Teachers', () => {
    const selectMatch = /<select class="name-tag-bulk-filter-select" id="training-assign-filter-select">[\s\S]*?<\/select>/.exec(res.text);
    assert.ok(selectMatch, 'expected the filter select');
    assert.match(selectMatch[0], /<option value="all">All<\/option>/);
    assert.match(selectMatch[0], /<option value="student">Students Only<\/option>/);
    assert.match(selectMatch[0], /<option value="primaryParent">Primary Parents Only<\/option>/);
    assert.match(selectMatch[0], /<option value="parent">Parents Only<\/option>/);
    assert.match(selectMatch[0], /<option value="admin">Admins Only<\/option>/);
    assert.match(selectMatch[0], /<option value="teacher">Teachers Only<\/option>/);
  });

  await t.test('Select All and Select None checkboxes are present', () => {
    assert.match(res.text, /id="training-assign-select-all-checkbox"/);
    assert.match(res.text, /id="training-assign-select-none-checkbox"/);
  });

  await t.test('each row carries the correct data-type/data-primary/data-teacher attributes for client-side filtering', () => {
    // The row-opening <tr> tag immediately precedes its own member's
    // checkbox in the markup - find that tag's start, then check its own
    // attributes, rather than a single regex trying to span the whole row.
    function rowAttrs(id) {
      const idx = res.text.indexOf(`value="${id}"`);
      const rowStart = res.text.lastIndexOf('<tr class="print-picker-row"', idx);
      return res.text.slice(rowStart, idx);
    }
    assert.match(rowAttrs(zed), /data-type="parent"/);
    assert.match(rowAttrs(zed), /data-primary="0"/);
    assert.match(rowAttrs(amy), /data-type="parent"/);
    assert.match(rowAttrs(amy), /data-primary="1"/);
    assert.match(rowAttrs(kid), /data-type="student"/);
    assert.match(rowAttrs(adm), /data-type="admin"/);
    assert.match(rowAttrs(teacherId), /data-teacher="1"/);
    assert.match(rowAttrs(zed), /data-teacher="0"/);
  });

  await t.test('training-assign-picker.js is loaded', () => {
    assert.match(res.text, /<script src="\/js\/training-assign-picker\.js"><\/script>/);
  });
});
