// Real HTTP-level coverage for a live bug report: on the Member
// Schedules tab (routes/admin-schedule.js's tab='members' branch),
// clicking "Select All" to archive only ever selected whichever
// members happened to be on the CURRENT page - with 18 pages of members,
// it silently archived none of the other 17 pages' worth. Root cause:
// "Select All" (public/js/archive-select-toggle.js) is a purely
// client-side DOM operation - it can only check a checkbox that actually
// exists in the page's HTML, and the server only ever rendered one
// checkbox per member on the paginated view's current page (PAGE_SIZE=25
// - see routes/admin-schedule.js). Fixed by also rendering one
// permanently-hidden checkbox (class="archive-offpage-checkbox", no card
// of its own) per active member NOT on the current page, so "Select All"
// has something to reach for every page, not just the one being viewed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-archive-select-all-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-archive-select-all-pagination-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=members&type=student').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

const PAGE_SIZE = 25; // must match routes/admin-schedule.js's own constant

test('Member Schedules (filtered to Students) page 1 of a multi-page list renders an off-page checkbox for every member on later pages, so Select All can reach them', async (t) => {
  const { cookie } = await loginAsAdmin();

  // 30 active students -> 2 pages (25 + 5) at PAGE_SIZE=25, alphabetized
  // by last name (byLastName) the same way the real page sorts them.
  const studentIds = [];
  for (let i = 0; i < 30; i++) {
    const name = `PagTest Student${String(i).padStart(2, '0')}`;
    const barcode = `pagtest-student-${i}`;
    const id = (await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(name, barcode, 'student')).lastInsertRowid;
    studentIds.push(id);
  }

  const page1 = await request(app).get('/admin/schedule?tab=members&type=student&page=1').set('Cookie', cookie);
  assert.equal(page1.status, 200);
  assert.match(page1.text, /Page 1 of 2 \(30 total\)/);

  const onPageIds = [...page1.text.matchAll(/name="memberIds" value="(\d+)" form="schedule-archive-form-members" class="archive-select-checkbox/g)].map((m) => Number(m[1]));
  const offPageIds = [...page1.text.matchAll(/name="memberIds" value="(\d+)" form="schedule-archive-form-members" class="archive-offpage-checkbox/g)].map((m) => Number(m[1]));

  await t.test('page 1 has exactly PAGE_SIZE visible per-card checkboxes', () => {
    assert.equal(onPageIds.length, PAGE_SIZE);
  });

  await t.test('every member NOT on page 1 gets a hidden off-page checkbox instead - none missing, none duplicated', () => {
    const expectedOffPage = studentIds.filter((id) => !onPageIds.includes(id));
    assert.equal(offPageIds.length, expectedOffPage.length, 'every member absent from this page must have exactly one off-page checkbox');
    assert.deepEqual([...offPageIds].sort((a, b) => a - b), [...expectedOffPage].sort((a, b) => a - b));
    // No id should ever get both kinds of checkbox - that would double it
    // up in a real "Select All" + submit.
    assert.deepEqual(onPageIds.filter((id) => offPageIds.includes(id)), []);
  });

  await t.test('the off-page checkboxes are unconditionally hidden (no card of their own to sit inside)', () => {
    for (const id of offPageIds) {
      assert.match(page1.text, new RegExp(`name="memberIds" value="${id}" form="schedule-archive-form-members" class="archive-offpage-checkbox"[^>]*hidden`));
    }
  });

  await t.test('archiving every id gathered from BOTH page 1\'s visible checkboxes and its off-page ones - exactly what a real "Select All" then submit produces - archives all 30, not just the 25 on page 1', async () => {
    const { cookie: freshCookie, csrfToken } = await loginAsAdmin();
    const allIds = [...onPageIds, ...offPageIds];
    assert.equal(allIds.length, 30);

    const res = await request(app)
      .post('/admin/schedule/members/archive')
      .set('Cookie', freshCookie)
      .type('form')
      .send({ memberIds: allIds, _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Archived 30 member schedule/);

    const archivedCount = (await db.prepare('SELECT COUNT(*) AS c FROM member_schedule_archives WHERE member_type = ?').get('student')).c;
    assert.equal(Number(archivedCount), 30);
  });
});

test('a single-member view (Name dropdown filter) renders no off-page checkboxes - "Select All" there should only ever mean the one person shown, not every page', async () => {
  const { cookie } = await loginAsAdmin();
  const soloId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Solo Filter Student', 'solo-filter-student', 'student')").run()).lastInsertRowid;

  const res = await request(app).get(`/admin/schedule?tab=members&type=student&memberId=${soloId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /class="archive-offpage-checkbox"/);
});
