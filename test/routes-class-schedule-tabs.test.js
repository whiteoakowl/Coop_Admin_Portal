// Real HTTP-level coverage for a bug report this session: every class
// create/edit/delete/import action in routes/admin-class-schedule.js
// redirects back to `/admin/class-schedule/:day` on success - a second,
// near-duplicate rendering of the exact same day grid the real Class
// Schedules tab (/admin/schedule?tab=monday|wednesday) shows, minus that
// page's Class/Student/Parent Schedules tab bar and Monday/Wednesday
// pill toggle. Every one of those actions was silently landing the admin
// on the tab-less duplicate instead of back where they started ("the top
// tabs disappear when editing a class"). Fixed by turning
// `/admin/class-schedule/:day` into a redirect straight to the real
// tabbed page (carrying every query param through), rather than
// rendering its own separate page - this suite is what proves that
// redirect actually happens and actually lands somewhere with the tabs
// present, not just a code-reading argument.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-tabs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-tabs-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const match = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  return { cookie, csrfToken: match ? match[1] : null };
}

function assertHasTabsAndToggle(html) {
  assert.match(html, /Class Schedules<\/a>/, 'the Class/Student/Parent Schedules tab bar should be present');
  assert.match(html, /Student Schedules<\/a>/);
  assert.match(html, /Parent Schedules<\/a>/);
  assert.match(html, /class="day-toggle no-print schedule-day-toggle"/, 'the Monday/Wednesday pill toggle should be present');
}

test('the bare /admin/class-schedule/:day route redirects to the real tabbed page', async (t) => {
  const { cookie } = await loginAsAdmin();

  await t.test('a plain visit redirects, preserving no extra query params', async () => {
    const res = await request(app).get('/admin/class-schedule/monday').set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/schedule?tab=monday');
  });

  await t.test('query params (notice/error/date) survive the redirect', async () => {
    const res = await request(app)
      .get('/admin/class-schedule/wednesday?notice=Deleted%20%22Art%20Class%22.&date=2026-01-07')
      .set('Cookie', cookie);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.location, 'http://localhost');
    assert.equal(location.pathname, '/admin/schedule');
    assert.equal(location.searchParams.get('tab'), 'wednesday');
    assert.equal(location.searchParams.get('notice'), 'Deleted "Art Class".');
    assert.equal(location.searchParams.get('date'), '2026-01-07');
  });

  await t.test('following the redirect lands on a page with the tabs and pill toggle present', async () => {
    const res = await request(app).get('/admin/class-schedule/monday').set('Cookie', cookie).redirects(1);
    assert.equal(res.status, 200);
    assertHasTabsAndToggle(res.text);
  });
});

test('the real Class Schedules tab shows all 12 class colors in the Create Class dialog', async (t) => {
  const { cookie } = await loginAsAdmin();

  await t.test('/admin/schedule?tab=monday has 12 color swatches and the tabs/toggle', async () => {
    const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assertHasTabsAndToggle(res.text);
    const swatchMatches = res.text.match(/class="class-color-swatch"/g) || [];
    assert.equal(swatchMatches.length, 12, 'the Create Class dialog should offer all 12 palette colors on first render');
  });
});

test('creating a class redirects back to the tabbed page, not the bare duplicate (representative of every create/edit/delete/import action in this file - they all redirect through the same shim)', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('creating a class redirects to /admin/schedule, not /admin/class-schedule', async () => {
    const res = await request(app)
      .post('/admin/class-schedule/classes/new')
      .set('Cookie', cookie)
      .type('form')
      .send({ day: 'monday', className: 'Regression Test Class', hourPosition: '1', color: '#EE9A4D', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/class-schedule\/monday\?notice=/, 'still redirects through the shim URL...');
    // ...which itself immediately redirects again to the real tabbed page - confirm that second hop too.
    const followed = await request(app).get(res.headers.location).set('Cookie', cookie);
    assert.equal(followed.status, 302);
    const location = new URL(followed.headers.location, 'http://localhost');
    assert.equal(location.pathname, '/admin/schedule');
    assert.equal(location.searchParams.get('tab'), 'monday');
    assert.match(location.searchParams.get('notice'), /Regression Test Class.*created/);
  });
});
