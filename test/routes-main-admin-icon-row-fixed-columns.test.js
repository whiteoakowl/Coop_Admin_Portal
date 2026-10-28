// A real request: "Main admin portal, all pages, all subpages, the icons
// and buttons should not be in columns, they should be in rows, next to
// each other" - same root cause as the earlier Co-op Admin request this
// mirrors (test/routes-admin-icon-row-fixed-columns.test.js): public/js/
// roster-btn-row-grid.js only auto-counts .roster-action-btn/.btn-
// secondary children when sizing a .roster-btn-row's mobile grid - a row
// of plain .icon-btn elements (or a mix where some children aren't
// counted, like partials/misc-badge-print-panel.ejs's own Print/Download
// PDF buttons) is invisible to that counter and silently stacks into one
// column instead. The fix is data-fixed-columns="N" on the row (computed
// inline where the real button count varies by condition). This test just
// confirms every Main Admin page/row found by that audit still renders
// with the right fixed column count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-icon-row-fixed-columns-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-icon-row-fixed-columns-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

// Counts how many roster-btn-row divs in the given HTML carry
// data-fixed-columns="n" for the given n, tolerant of extra classes on the
// same div (e.g. class="roster-btn-row photo-album-card-icons").
function countFixedColumnRows(html, n) {
  const re = new RegExp(`class="roster-btn-row[^"]*"\\s+data-fixed-columns="${n}"`, 'g');
  return (html.match(re) || []).length;
}

test('Main Admin pages: icon/button rows that the mobile grid JS cannot auto-count carry data-fixed-columns', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const signupListRes = await request(app).post('/main-admin/volunteers/signup-lists').type('form').set('Cookie', cookie).send({ _csrf: csrfToken, title: 'Icon Row Test Signup List' });
  const signupListId = /\/signup-lists\/(\d+)\?/.exec(signupListRes.headers.location)[1];

  const volunteerListRes = await request(app).post('/main-admin/volunteers/volunteer-lists').type('form').set('Cookie', cookie).send({ _csrf: csrfToken, title: 'Icon Row Test Volunteer List' });
  const volunteerListId = /\/volunteer-lists\/(\d+)\?/.exec(volunteerListRes.headers.location)[1];

  await request(app).post('/main-admin/photos').type('form').set('Cookie', cookie).send({ _csrf: csrfToken, title: 'Icon Row Test Album' });

  const cases = [
    // /main-admin/events is deliberately NOT here any more - a later real
    // request ("Print, pdf, import and export icons should be on the same
    // row as the calendar and list view icons") merged the Calendar/List
    // view toggle into this row, mixing .roster-action-btn with plain
    // .icon-btn children whose real count varies by tab - roster-btn-
    // row-fit-text (content-sized flex-wrap) replaced data-fixed-columns
    // here, same as it did for the registration log's own date-picker +
    // icon row. See test/routes-events-shared-calendar.test.js for that
    // page's own coverage.
    { url: '/main-admin/photos', columns: 3 },
    { url: '/main-admin/admins', columns: 3 },
    // /main-admin/members/grade-level-report is deliberately NOT here any
    // more - a later real request ("Grade level report. Filter button
    // should be on the same row as the icons and be first in the row")
    // moved this row to roster-btn-row-fit-text too, same reasoning (and
    // same fix) as /main-admin/events and /main-admin/members just above/
    // below - a mixed Filter (.roster-action-btn) + Export/Print/PDF
    // (.icon-btn) row sized to its own content instead of a fixed-column
    // grid, so it no longer carries data-fixed-columns at all. See
    // test/routes-main-admin-members-grade-level-report.test.js for this
    // page's own coverage.
    { url: '/main-admin/name-tags?tab=requests', columns: 3 },
    { url: `/main-admin/volunteers/signup-lists/${signupListId}`, columns: 3 },
    { url: `/main-admin/volunteers/volunteer-lists/${volunteerListId}`, columns: 3 },
    // /main-admin/members is deliberately NOT here any more - a later
    // real request ("Filter button should be on the same row as icons.
    // Orange buttons shrink to fit more on each row side by side") moved
    // its icon row to roster-btn-row-fit-text (content-sized flex, not an
    // equal-width grid) so Filter's longer label can share the row
    // without forcing the icons into a narrow equal column - that row no
    // longer needs (or carries) data-fixed-columns at all, since display:
    // flex makes the JS's own grid-column-count calc moot either way. See
    // test/routes-main-admin-members-mobile-button-order.test.js for its
    // own coverage of that row's actual content/order.
  ];

  for (const { url, columns } of cases) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `${url} should render 200`);
    if (columns === 0) {
      // Settings tab's own row renders empty (no icons at all on that
      // tab) - data-fixed-columns="0" is harmless there (roster-btn-row-
      // grid.js only acts on a positive count), just confirm the row
      // itself still renders rather than asserting a fixed-columns count.
      assert.match(res.text, /class="roster-btn-row no-print" data-fixed-columns="0"/, `${url} should render its empty icon row`);
      continue;
    }
    assert.ok(
      countFixedColumnRows(res.text, columns) >= 1,
      `${url} should have a roster-btn-row with data-fixed-columns="${columns}"`
    );
  }

  // partials/misc-badge-print-panel.ejs's own row is shared by both of
  // Name Tags' Design tab panels (setupCleanup, custom) - each needs its
  // own different real count (Filter+Print+PDF vs. Import+Sample
  // File+Print+PDF).
  const nameTagsPrint = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(nameTagsPrint.status, 200);
  assert.equal(countFixedColumnRows(nameTagsPrint.text, 3), 1, 'setupCleanup badges panel should have one data-fixed-columns="3" row (Filter+Print+PDF)');
  assert.equal(countFixedColumnRows(nameTagsPrint.text, 4), 1, 'custom badges panel should have one data-fixed-columns="4" row (Import+Sample File+Print+PDF)');
});
