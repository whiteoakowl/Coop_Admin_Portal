// A real request: "member page. add/edit families should be one button.
// combine the feature." Used to be two separate buttons (+ Add Family,
// Edit Families) opening two separate dialogs - now one "Families" button
// opens one dialog with an "add new" row on top of the existing rename/
// delete list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-families-combined-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-families-combined-test-uploads-${process.pid}`);
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

test('Members page: a single "Families" button opens one dialog with add + rename/delete together', async (t) => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  await db.prepare("INSERT INTO families (name) VALUES ('Combined Dialog Family')").run();

  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('only one toolbar button opens the families dialog - the old separate Add/Edit Families buttons are gone', () => {
    assert.match(res.text, /manage-families-dialog['"]\)\.showModal\(\)"[^>]*>Families</);
    assert.doesNotMatch(res.text, />\+ Add Family</);
    assert.doesNotMatch(res.text, />Edit Families</);
  });

  await t.test('the combined dialog has both the add-new form and the existing family in one place', () => {
    const dialogMatch = /<dialog id="manage-families-dialog"[\s\S]*?<\/dialog>/.exec(res.text);
    assert.ok(dialogMatch, 'expected exactly one combined families dialog');
    assert.match(dialogMatch[0], /action="\/admin\/members\/families\/new"/, 'add-new form should be inside the combined dialog');
    assert.match(dialogMatch[0], /Combined Dialog Family/, 'existing family should still list for rename/delete');
  });

  await t.test('no leftover separate add-family-dialog/edit-families-dialog ids remain', () => {
    assert.doesNotMatch(res.text, /id="add-family-dialog"/);
    assert.doesNotMatch(res.text, /id="edit-families-dialog"/);
  });
});
