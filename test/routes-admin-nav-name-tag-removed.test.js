// A real request: "co-op admin portal. there should not be a dashboard
// tab for name tags. that is already in design/print tab." The Co-op
// Admin sidebar (views/partials/admin-nav.ejs) used to carry a separate
// "Name Tag" dropdown pointing at the older /admin/name-tag page
// alongside "Design/Print" (/admin/design) - Design/Print's own Design
// tab already offers Student/Parent/Admin Name Tag as a design type, and
// its Print tab already prints Name Tags/Name Tag Requests, so the
// standalone nav entry was a redundant second way to reach the same
// feature. This locks in that the nav link (not the underlying page,
// which stays directly reachable by URL) is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-nav-name-tag-removed-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-nav-name-tag-removed-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('Co-op Admin sidebar has no standalone Name Tag nav item, but Design/Print is still there', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(page.status, 200);

  const navMatch = /<nav id="admin-nav-links">([\s\S]*?)<\/nav>/.exec(page.text);
  assert.ok(navMatch, 'expected the admin sidebar nav');
  const nav = navMatch[1];

  assert.doesNotMatch(nav, /href="\/admin\/name-tag"/, 'the standalone Name Tag nav item should be gone');
  assert.doesNotMatch(nav, />Name Tag</, 'no "Name Tag" label should remain in the sidebar');
  assert.match(nav, /href="\/admin\/design"/);
  assert.match(nav, /Design\/Print/);

  // The underlying page is still directly reachable, just not from the nav.
  const stillWorks = await request(app).get('/admin/name-tag').set('Cookie', cookie);
  assert.equal(stillWorks.status, 200);
});
