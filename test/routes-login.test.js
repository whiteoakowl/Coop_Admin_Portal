// Real HTTP-level coverage for the admin login flow (audit finding
// TEST-01) - the one workflow every other admin action depends on, so a
// silent regression here (a bad merge to the redirect-safety check, the
// rate limiter no longer actually blocking, a session cookie that stops
// getting set) would be worse than almost anything else breaking.
// Boots the real app (server.js, exported for exactly this - see its own
// comment) against a throwaway DB_PATH, the same override pattern used
// by test/designImageGC.test.js and friends, rather than mocking any of
// the pieces involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-login-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-login-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const { MAX_ATTEMPTS } = require('../utils/loginRateLimit');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('login', async (t) => {
  await t.test('correct credentials set a session cookie and redirect to /admin', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword123' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin');
    const cookie = res.headers['set-cookie'];
    assert.ok(cookie && cookie.length > 0, 'expected a session cookie to be set');

    // The cookie actually grants access, not just exists - hit an
    // admin-only route with it and confirm no login redirect.
    const dashboard = await request(app).get('/admin').set('Cookie', cookie);
    assert.equal(dashboard.status, 200);
  });

  await t.test('wrong password re-renders the login page and does not grant access', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'wrong-password' });
    assert.equal(res.status, 200); // re-renders admin-login, not a redirect
    assert.match(res.text, /Invalid username or password/);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('an unauthenticated request to an admin route redirects to login with the original URL preserved', async () => {
    const res = await request(app).get('/admin/members?tab=classes');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/login?next=%2Fadmin%2Fmembers%3Ftab%3Dclasses');
  });

  await t.test('an off-site next value is rejected and falls back to /admin (open-redirect guard)', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword123', next: 'https://evil.example/phish' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin');
  });

  await t.test('a protocol-relative next value ("//evil.example") is also rejected', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword123', next: '//evil.example' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin');
  });

  await t.test('a valid same-origin next value is honored', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword123', next: '/admin/members' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/members');
  });

  await t.test('repeated failures from the same IP are rate-limited after the threshold', async () => {
    // supertest requests from this file all share the test framework's
    // loopback address, so consecutive failures accumulate against the
    // same key isRateLimited(req.ip) checks - MAX_ATTEMPTS wrong
    // passwords should be enough to trip it (some headroom already used
    // by the "wrong password" case above, from the same IP).
    let lastRes;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      lastRes = await request(app)
        .post('/admin/login')
        .type('form')
        .send({ username: 'testadmin', password: 'still-wrong' });
    }
    assert.match(lastRes.text, /Too many login attempts/);

    // Confirm it blocks even a CORRECT password once tripped - the guard
    // exists specifically to slow down a guesser who eventually gets
    // lucky, not just to reject known-bad attempts.
    const correctButBlocked = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword123' });
    assert.match(correctButBlocked.text, /Too many login attempts/);
    assert.equal(correctButBlocked.headers['set-cookie'], undefined);
  });
});
