// A real request: "All co-op admin portal pages the export, import, print
// and pdf icons should be in a row side by side. Not in a single column."
// public/js/roster-btn-row-grid.js lays out .roster-btn-row as a CSS grid
// on mobile by counting .roster-action-btn/.btn-secondary children - a row
// of plain .icon-btn icons (Export/Import/Print/PDF) is invisible to that
// counter and silently stacks into one column instead. The fix (already
// established for admin-accounting-list.ejs before this batch) is
// data-fixed-columns="N" on the row, which the JS reads first. This test
// just confirms every Co-op Admin page touched by this request still
// renders its icon row with the right fixed column count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-icon-row-fixed-columns-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-icon-row-fixed-columns-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

// Counts how many roster-btn-row divs in the given HTML carry
// data-fixed-columns="n" for the given n, so a test can assert "at least
// one row was fixed to N columns" without depending on exact row ordering.
function countFixedColumnRows(html, n) {
  const re = new RegExp(`class="roster-btn-row[^"]*"\\s+data-fixed-columns="${n}"`, 'g');
  return (html.match(re) || []).length;
}

test('Co-op Admin pages: export/import/print/pdf icon rows carry data-fixed-columns', async () => {
  const { cookie } = await loginAsAdmin();

  const cases = [
    { url: '/admin/design?tab=requests', columns: 3 },
    { url: '/admin/logs?tab=absence', columns: 3 },
    { url: '/admin/logs?tab=classregistration', columns: 3 },
    { url: '/admin/logs?tab=missedduty', columns: 3 },
    { url: '/admin/logs?tab=checkinout', columns: 3 },
    { url: '/admin/logs?tab=classcheckinout', columns: 3 },
    { url: '/admin/logs?tab=nametag', columns: 3 },
    { url: '/admin/logs?tab=classrisk', columns: 3 },
    { url: '/admin/logs?tab=allergies', columns: 3 },
    { url: '/admin/logs?tab=substitutes', columns: 2 },
    { url: '/admin/members/grade-level-report', columns: 3 },
    { url: '/admin/members', columns: 3 },
    { url: '/admin/name-tag?tab=requests', columns: 3 },
    { url: '/admin/rosters?tab=monday-parent', columns: 3 },
    { url: '/admin/schedule?tab=members', columns: 4 },
    { url: '/admin/schedule?tab=classregistrationlog', columns: 3 },
    { url: '/admin/setup/monday/assignments', columns: 3 },
    { url: '/admin/setup/monday/tasks', columns: 4 },
    { url: '/admin/setup/monday/manage', columns: 3 },
    { url: '/admin/volunteers/monday/risk', columns: 3 },
    { url: '/admin/volunteers/monday/manage', columns: 3 },
  ];

  for (const { url, columns } of cases) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `${url} should render 200`);
    assert.ok(
      countFixedColumnRows(res.text, columns) >= 1,
      `${url} should have a roster-btn-row with data-fixed-columns="${columns}"`
    );
  }
});
