// A real request: "to change the role permissions for each admin, you
// should be able to go to the admin settings page, click on each admin
// title and then there will be a popup to check which permissions that
// admin may have. Save button and close button." Roles & Permissions used
// to show every role's full permission checkbox grid expanded inline,
// permanently on the page - each role's title (member-name-link, the same
// button-reset-to-plain-link class the Archive tables already use to open
// a popup) now opens its own <dialog> with that role's own checkboxes plus
// Save/Close, instead of a wall of always-visible grids.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-roles-dialog-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-roles-dialog-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123', next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Roles & Permissions: each non-Main-Admin role has a clickable title opening its own dialog with Save/Close, not an always-visible grid', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/roles').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const role = await db.prepare("SELECT * FROM roles WHERE key != 'main_admin' LIMIT 1").get();
  assert.ok(role, 'expected at least one non-Main-Admin role to exist');

  // The title itself is the trigger - a plain-link-styled button, not a
  // static heading, and it opens THIS role's own dialog by id.
  const titleBtnRe = new RegExp(
    `<button type="button" class="member-name-link" onclick="document\\.getElementById\\('role-permissions-dialog-${role.id}'\\)\\.showModal\\(\\)">${role.label}</button>`
  );
  assert.match(res.text, titleBtnRe);

  const dialogMatch = new RegExp(`<dialog id="role-permissions-dialog-${role.id}"[^]*?</dialog>`).exec(res.text);
  assert.ok(dialogMatch, 'expected this role to have its own dialog');
  const dialogHtml = dialogMatch[0];
  assert.match(dialogHtml, /class="permission-checkbox-grid"/);
  assert.match(dialogHtml, new RegExp(`action="/main-admin/roles/${role.id}/permissions"`));
  assert.match(dialogHtml, /<button type="button" class="btn-secondary" onclick="this\.closest\('dialog'\)\.close\(\)">Close<\/button>/);
  assert.match(dialogHtml, /<button type="submit" class="primary-btn">Save<\/button>/);

  // The old always-expanded-inline form/checkbox-grid shape (one big
  // "Save Permissions for X" button per role, no dialog) should be gone.
  assert.doesNotMatch(res.text, /Save Permissions for/);
});

test('saving a role\'s permissions through the dialog\'s own form still persists correctly', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/roles').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const role = await db.prepare("SELECT * FROM roles WHERE key != 'main_admin' LIMIT 1").get();
  const perm = await db.prepare('SELECT id FROM permissions ORDER BY label LIMIT 1').get();

  const res = await request(app)
    .post(`/main-admin/roles/${role.id}/permissions`)
    .set('Cookie', cookie)
    .type('form')
    .send({ permissionIds: String(perm.id), _csrf: csrfToken });
  assert.equal(res.status, 302);

  const grant = await db.prepare('SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?').get(role.id, perm.id);
  assert.ok(grant, 'the permission should have been saved');
});
