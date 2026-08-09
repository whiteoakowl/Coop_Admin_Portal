// Real unit coverage for requireAdmin/requireFullAdmin - specifically
// that they stay behaviorally identical (see requireFullAdmin.js's own
// comment for why that matters: several routers gate themselves with a
// blanket router.use(requireFullAdmin), which - because it runs ahead of
// that router's own per-route middleware - means a fetch() call to one of
// those routes hits *this* file, not requireAdmin, on an expired session.
// A real inconsistency here (requireFullAdmin missing the JSON-vs-redirect
// branch requireAdmin has) let a redirect-to-login-HTML slip past a
// caller's res.json() and surface as a misleading "connection error"
// instead of a "please log in again" - this suite exists so that
// regression can't silently come back.
const test = require('node:test');
const assert = require('node:assert/strict');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');

function mockRes() {
  const res = {
    statusCode: null,
    redirectedTo: null,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
    },
  };
  return res;
}

for (const [name, middleware] of [['requireAdmin', requireAdmin], ['requireFullAdmin', requireFullAdmin]]) {
  test(name, async (t) => {
    await t.test('calls next() when a session is present', () => {
      const req = { session: { adminId: 1 }, headers: {}, originalUrl: '/admin/members' };
      const res = mockRes();
      let calledNext = false;
      middleware(req, res, () => {
        calledNext = true;
      });
      assert.equal(calledNext, true);
      assert.equal(res.redirectedTo, null);
      assert.equal(res.jsonBody, null);
    });

    await t.test('redirects to login (with the original URL preserved) when there is no session and no JSON was requested', () => {
      const req = { session: null, headers: {}, originalUrl: '/admin/members?tab=x' };
      const res = mockRes();
      middleware(req, res, () => assert.fail('next() should not be called'));
      assert.equal(res.redirectedTo, '/admin/login?next=%2Fadmin%2Fmembers%3Ftab%3Dx');
      assert.equal(res.jsonBody, null);
    });

    await t.test('returns 401 JSON instead of a redirect when the request wants JSON', () => {
      const req = { session: {}, headers: { accept: 'application/json' }, originalUrl: '/admin/library/scan-member' };
      const res = mockRes();
      middleware(req, res, () => assert.fail('next() should not be called'));
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.jsonBody, { error: 'Not authenticated' });
      assert.equal(res.redirectedTo, null);
    });

    await t.test('a session with no adminId is treated the same as no session', () => {
      const req = { session: {}, headers: {}, originalUrl: '/admin/members' };
      const res = mockRes();
      middleware(req, res, () => assert.fail('next() should not be called'));
      assert.equal(res.redirectedTo, '/admin/login?next=%2Fadmin%2Fmembers');
    });
  });
}
