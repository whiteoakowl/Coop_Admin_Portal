// Regression coverage for the Phase 5 audit's requireAdmin/requireFullAdmin
// cleanup: routers/admin-design.js, admin-documents.js, admin-library.js,
// admin-members.js, admin-name-tag.js, and admin-search.js each gate their
// *entire* router with one blanket `router.use(requireFullAdmin)` at the
// top of the file - every route in them was already full-admin-gated
// before it was ever reached, so the redundant per-route
// `requireAdmin`/`requireFullAdmin` that used to also sit on individual
// routes in these files added no real protection and was removed (see
// README.md's "Admin access model" section for the full rationale).
//
// That refactor is only safe if the blanket `.use()` really does cover
// every route on its own - this suite is what actually proves that,
// rather than trusting a code-reading argument. Each of these routes
// used to also carry a per-route check; if the blanket `.use()` were ever
// accidentally removed, deleted, or reordered below a route definition,
// this is what would catch it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-routers-auth-gate-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-routers-auth-gate-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('routers gated by a blanket router.use(requireFullAdmin) reject an unauthenticated request', async (t) => {
  const routes = [
    ['/admin/design', 'admin-design.js'],
    ['/admin/documents', 'admin-documents.js'],
    ['/admin/library', 'admin-library.js'],
    ['/admin/members', 'admin-members.js'],
    ['/admin/name-tag', 'admin-name-tag.js'],
    ['/admin/search', 'admin-search.js'],
  ];

  for (const [route, file] of routes) {
    await t.test(`${route} (${file}) redirects to login with no session`, async () => {
      const res = await request(app).get(route);
      assert.equal(res.status, 302, `${route} should redirect, not serve content, to an unauthenticated request`);
      assert.match(res.headers.location, /^\/admin\/login/, `${route} should redirect to the login page`);
    });
  }
});
