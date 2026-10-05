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

test('Portal Permissions: each non-Main-Admin role has a centered title, portal key underneath, and a "View" button opening its own dialog with Save/Close', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/roles').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Portal Permissions<\/h1>/);

  const role = await db.prepare("SELECT * FROM roles WHERE key != 'main_admin' LIMIT 1").get();
  assert.ok(role, 'expected at least one non-Main-Admin role to exist');

  // A real request: "each portal card should have a centered title,
  // portal key listed stacked underneath in next row." The title is now
  // a plain heading (not the dialog trigger itself) - a separate "View"
  // button opens this role's own dialog by id.
  const cardRe = new RegExp(
    `<section class="portal-dashboard-card main-admin-portal-permissions-card">\\s*<h2>${role.label}</h2>\\s*<p class="hint">portal key: ${role.key}</p>`
  );
  assert.match(res.text, cardRe);
  const viewBtnRe = new RegExp(`<button type="button" class="roster-action-btn" onclick="document\\.getElementById\\('role-permissions-dialog-${role.id}'\\)\\.showModal\\(\\)">View</button>`);
  assert.match(res.text, viewBtnRe);

  const dialogMatch = new RegExp(`<dialog id="role-permissions-dialog-${role.id}"[^]*?</dialog>`).exec(res.text);
  assert.ok(dialogMatch, 'expected this role to have its own dialog');
  const dialogHtml = dialogMatch[0];
  // A real request: "it says view, not manage. Portals will not have
  // management controls. Only admins." Same editable checkboxes/Save as
  // before (only an account with manage_roles can even reach this page)
  // - just worded as viewing a portal's pages rather than "managing
  // permissions".
  assert.match(dialogHtml, new RegExp(`<h3>View ${role.label}'s Pages</h3>`));
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
