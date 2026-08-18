// Real bug report: "print rosters should shrink to fit all rows and
// columns on one page." The Attendance Archive print page used to stack
// every section (Parent, Student, each class) inside ONE shared
// .print-page with no shrink-to-fit at all - a term's worth of session
// dates and a full roster spilled across however many physical pages the
// browser's own page-break happened to land on, mid-table. Each section
// now gets its own page, independently shrunk to fit - see admin-rosters-
// archive-print.ejs's own comment. This covers the restructure: one
// .print-page per section, each carrying its own print-header and a
// data-shrink-to-fit wrapper, with page-break-after between them (but not
// after the last one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-archive-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-archive-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

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
  const page = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Attendance Archive print: one shrink-to-fit page per section', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const studentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Students'").get();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Print Test Kid', 'archive-print-test-kid', 'student')")
    .run();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(studentRoster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(studentRoster.id, memberId);

  const archiveRes = await request(app).post('/admin/rosters/monday/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(archiveRes.status, 302);
  const archive = await db.prepare("SELECT id FROM roster_archives WHERE day = 'monday' ORDER BY id DESC LIMIT 1").get();
  assert.ok(archive, 'sanity check: the archive should have been created');

  await t.test('the print page renders one .roster-archive-print-page per section, each with its own header + shrink wrapper', async () => {
    const res = await request(app).get(`/admin/rosters/archive/${archive.id}/print`).set('Cookie', cookie);
    assert.equal(res.status, 200);

    const pageCount = (res.text.match(/class="print-page roster-archive-print-page"/g) || []).length;
    // Monday Parents + Monday Students, at minimum - one page each, even
    // with zero classes archived alongside them.
    assert.ok(pageCount >= 2, `expected at least 2 archive print pages (Parent + Student), got ${pageCount}`);

    const headerCount = (res.text.match(/class="print-header"/g) || []).length;
    assert.equal(headerCount, pageCount, 'every section page should carry its own print-header, not one shared header for all of them');

    const shrinkWrapperCount = (res.text.match(/class="roster-archive-print-fit" data-shrink-to-fit/g) || []).length;
    assert.equal(shrinkWrapperCount, pageCount, 'every section page should have its own shrink-to-fit wrapper around its table');

    assert.match(res.text, /Archive Print Test Kid/);
  });

  await t.test('print-shrink-to-fit.js is loaded so the shrink actually runs', async () => {
    const res = await request(app).get(`/admin/rosters/archive/${archive.id}/print`).set('Cookie', cookie);
    assert.match(res.text, /<script src="\/js\/print-shrink-to-fit\.js"><\/script>/);
  });
});
