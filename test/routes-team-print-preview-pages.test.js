// A real bug report: "floater team and setup cleanup teams should have a
// print preview before going to print." Both manage pages' own Print
// buttons used to call window.print() directly on themselves - straight
// to the OS print dialog with no review step, unlike every other print
// button site-wide, which lands on a dedicated read-only preview page
// first. Covers: the manage page's Print button now links to that
// dedicated page (not window.print()), the dedicated page itself renders
// the same team content read-only, and it carries its own visible Print
// button (the same "look it over, THEN click Print" pattern admin-setup-
// tasks-print.ejs already established).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `team-print-preview-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `team-print-preview-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');

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

test('Setup/Cleanup Teams: Print button links to a dedicated preview page instead of calling window.print() directly', async () => {
  const cookie = await loginAsAdmin();
  await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Preview Test Team')").run();

  const manage = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /href="\/admin\/setup\/monday\/teams\/print"[^>]*target="_blank"/, 'Print button should link to the preview page, not call window.print() on itself');
  assert.doesNotMatch(manage.text, /print-action-btn" onclick="window\.print\(\)"/, 'the old direct-to-print-dialog button should be gone');

  const preview = await request(app).get('/admin/setup/monday/teams/print').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Preview Test Team/);
  assert.match(preview.text, /class="print-preview-header no-print"/, 'the preview page should have its own no-print header');
  assert.match(preview.text, /roster-action-btn print-action-btn" onclick="window\.print\(\)"/, 'the preview page itself should have the real Print button');
  assert.match(preview.text, /team-print-page-fit/, 'should reuse the same one-team-per-page print wrapper as the live manage page');
});

test('Floater Teams: Print button links to a dedicated preview page instead of calling window.print() directly', async () => {
  const cookie = await loginAsAdmin();
  const list = await getListByDay('monday');
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Preview Floater', 'preview-floater-1', 'parent')").run()).lastInsertRowid;
  await addMemberToSection(list.id, memberId, hour1.id);

  const manage = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /href="\/admin\/volunteers\/monday\/teams\/print"[^>]*target="_blank"/, 'Print button should link to the preview page, not call window.print() on itself');

  const preview = await request(app).get('/admin/volunteers/monday/teams/print').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Preview Floater/);
  assert.match(preview.text, /class="print-preview-header no-print"/, 'the preview page should have its own no-print header');
  assert.match(preview.text, /roster-action-btn print-action-btn" onclick="window\.print\(\)"/, 'the preview page itself should have the real Print button');
});

// A real bug report: "the mobile print button for setup cleanup teams...
// did not show the leader name, location, or time" - turned out to mean
// the preview screen itself (before actually printing/saving PDF), not
// the print/PDF output, which was already correct. .team-print-meta (the
// only markup carrying Leader/Time/Location on this dedicated preview
// page) is CSS display:none by default and only flips to visible in
// @media print - the live manage page has its own separate, always-
// visible .team-info-meta-row to show those fields on screen, but this
// preview page has no such fallback, so the fields were genuinely
// invisible to anyone looking at the preview before printing. Fixed by
// giving this page's <body> its own class (.team-print-preview-page)
// and forcing .team-print-meta visible unconditionally scoped to it.
test('Setup/Cleanup Teams print preview page shows Leader/Time/Location on screen, not just under @media print', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Screen Leader', 'screen-leader-1', 'parent')").run()).lastInsertRowid;
  await db.prepare(
    "INSERT INTO setup_teams (day, title, leader_id, meeting_time, meeting_location) VALUES ('monday', 'Meta Test Team', ?, '8:30 AM', 'Main Hall')"
  ).run(memberId);

  const preview = await request(app).get('/admin/setup/monday/teams/print').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /class="admin-page setup-teams-print-page team-print-preview-page"/, 'the preview page must carry its own body class so .team-print-meta can be forced visible on screen, scoped away from the live manage page');
  assert.match(preview.text, /Screen Leader/);
  assert.match(preview.text, /8:30 AM/);
  assert.match(preview.text, /Main Hall/);
});

test('print preview pages require admin login, same as the manage pages they mirror', async () => {
  const res1 = await request(app).get('/admin/setup/monday/teams/print');
  assert.equal(res1.status, 302, 'unauthenticated request should redirect to login');
  const res2 = await request(app).get('/admin/volunteers/monday/teams/print');
  assert.equal(res2.status, 302, 'unauthenticated request should redirect to login');
});
