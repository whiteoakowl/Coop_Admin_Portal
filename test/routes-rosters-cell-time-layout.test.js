// Real bug report: the P/L/A status bubble and its check-in/out times sat
// side by side in the same <td> instead of stacked - a real cell.checkInTime/
// cell.checkOutTime span (public/css/styles.css's .cell-time, already
// small font) forced every date column wide enough to fit "In 10:02 AM"
// next to the circle, not just tiny print tucked under it. The CSS for a
// flex-column wrapper (.cell-detailed) already existed but was never
// actually applied in the markup. Fixed by wrapping the select/tag/time
// spans in that div in both the live grid (views/admin-rosters.ejs) and
// the read-only archive grid (views/partials/roster-archive-grid-table.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `rosters-cell-time-layout-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `rosters-cell-time-layout-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('the live Attendance grid wraps a cell\'s status bubble + check-in/out times in .cell-detailed, not side by side', async () => {
  const { cookie } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cell Layout Student', 'cell-layout-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-01-05';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, ?, ?)').run(memberId, rosterId, today, 7, Date.now());

  const res = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Cell Layout Student/);
  assert.match(res.text, /In \d/, 'a real check-in time should render');
  assert.match(res.text, /Out \d/, 'a real check-out time should render');

  // The select + tag + both time spans must all be nested inside one
  // .cell-detailed wrapper div, not siblings loose in the <td>.
  const wrapperRe = /<div class="cell-detailed">\s*<select class="roster-cell-select[^]*?<\/select>\s*<span class="print-only-tag[^]*?<\/span>\s*<span class="cell-time">In [^<]*<\/span>\s*<span class="cell-time">Out [^<]*<\/span>\s*<\/div>/;
  assert.match(res.text, wrapperRe, 'select/tag/In/Out must all be direct children of one .cell-detailed div');
});

test('the read-only Archive grid also wraps its tag + check-in/out times in .cell-detailed', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Cell Layout Student', 'archive-cell-layout-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-01-12'; // different date than the first test in this file - same roster's roster_dates row must not collide
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, ?, ?)').run(memberId, rosterId, today, 9, Date.now());

  await request(app).post('/admin/rosters/monday/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const archive = await db.prepare("SELECT id FROM roster_archives WHERE day = 'monday' ORDER BY id DESC LIMIT 1").get();
  const res = await request(app).get(`/admin/rosters/archive/${archive.id}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Archive Cell Layout Student/);

  const wrapperRe = /<div class="cell-detailed">\s*<span class="cell-tag[^]*?<\/span>\s*<span class="cell-time">In [^<]*<\/span>\s*<span class="cell-time">Out [^<]*<\/span>\s*<\/div>/;
  assert.match(res.text, wrapperRe, 'tag/In/Out must all be direct children of one .cell-detailed div in the archive view too');
});
