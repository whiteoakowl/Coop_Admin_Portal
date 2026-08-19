// Coverage for the Design/Print hub's "Primary Parents Only" name tag
// print-picker filter - a real request: "for printing name tags add/change
// the drop down choice to have primary parent and parent. we usually only
// need to print primary parent." Mirrors test/routes-admin-design-teacher-
// filter.test.js's own reasoning: the filter itself is client-side JS a
// jsdom-free route test can't exercise directly, so this locks in the
// markup contract public/js/design-print-hub.js's filter logic depends on -
// a primary parent gets data-primary="1", everyone else gets "0", and the
// Name Tags dropdown offers both Primary Parents Only (defaulted selected,
// since that's the common case) and the existing Parents Only (every
// parent) options.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-design-primary-parent-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-design-primary-parent-filter-test-uploads-${process.pid}`);
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

test('Design/Print hub print tab marks primary parents with data-primary, and the Name Tags filter defaults to Primary Parents Only', async () => {
  await db.prepare("INSERT INTO members (name, barcode, member_type, is_primary_parent) VALUES ('Pat Primary', 'Pat Primary', 'parent', 1)").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type, is_primary_parent) VALUES ('Sam Secondary', 'Sam Secondary', 'parent', 0)").run();

  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const primaryRow = new RegExp(`data-type="parent" data-teacher="0" data-primary="1"[^>]*data-name="pat primary"`);
  const secondaryRow = new RegExp(`data-type="parent" data-teacher="0" data-primary="0"[^>]*data-name="sam secondary"`);
  assert.match(res.text, primaryRow, 'a primary parent gets data-primary="1"');
  assert.match(res.text, secondaryRow, 'a non-primary parent gets data-primary="0"');
  assert.match(res.text, /<option value="primaryParent" selected>Primary Parents Only<\/option>/, 'Primary Parents Only should be the default selection');
  assert.match(res.text, /<option value="parent">Parents Only<\/option>/, 'Parents Only (every parent) should still be offered');
});
