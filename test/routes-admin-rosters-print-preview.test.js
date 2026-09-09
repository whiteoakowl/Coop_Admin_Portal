// Real request: "make sure there is a print preview for all attendance
// print pages." The grid Print button (Parent/Student/Class tabs) and the
// Playground log's own Print button used to call window.print() directly
// on the live, editable page - now both land on a dedicated read-only
// preview page (admin-rosters-print.ejs) first, matching every other
// print button in this app.
//
// Follow-up request: "attendance printing the roster can stretch to two
// pages so the font can be 12 point" - the live grid's own data-shrink-
// to-fit-on-print forced everything onto one (illegibly small) page; this
// preview instead starts at 12pt and lets a long roster flow across more
// than one physical page.
//
// Second follow-up: "printing skips the first page. width should fit to
// page. height should shrink to fit attendance 50 per page." - rows are
// now split into fixed 50-row .roster-print-chunk groups, each with its
// own repeated print header and a forced page break before the next one
// (see routes/admin-rosters.js's own comment on the /rosters/print
// route, and styles.css's comment on .roster-print-chunk, for why this
// deliberately does NOT reuse the shrink-to-fit mechanism the Attendance
// Archive print page uses for the same "page per section" shape - it
// was found to silently drop rows for a wide/dense enough roster).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-print-preview-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-print-preview-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('GET /admin/rosters/print', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('the live Parent/Student grid Print button links to the preview route instead of calling window.print() directly', async () => {
    const res = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/admin\/rosters\/print\?tab=monday-parent"/);
    assert.doesNotMatch(res.text, /print-action-btn" onclick="window\.print\(\)"/);
  });

  await t.test('?tab=monday-parent renders a read-only preview with a Print button, no shrink-to-fit wrapper, and no editable controls', async () => {
    const { ensureDayRoster } = require('../utils/classSchedule');
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Parent', 'print-preview-parent', 'parent') RETURNING id").get()).id;
    const rosterId = await ensureDayRoster('monday', 'parent');
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterId, memberId);

    const res = await request(app).get('/admin/rosters/print?tab=monday-parent').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Print Preview Parent/);
    assert.match(res.text, /onclick="window\.print\(\)"/);
    assert.doesNotMatch(res.text, /data-shrink-to-fit-on-print/);
    assert.doesNotMatch(res.text, /<select/);
  });

  await t.test('an unrecognized tab falls back to the default day\'s Parent roster instead of crashing - same graceful fallback as the live GET /rosters route', async () => {
    const res = await request(app).get('/admin/rosters/print?tab=not-a-real-tab').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Parents Attendance/);
  });

  await t.test('a nonexistent class id 404s instead of crashing', async () => {
    const res = await request(app).get('/admin/rosters/print?tab=class-999999').set('Cookie', cookie);
    assert.equal(res.status, 404);
  });

  await t.test('a class tab (class-<id>) also gets a working print preview', async () => {
    const cls = await db.prepare("SELECT id, class_name FROM classes WHERE day = 'monday' LIMIT 1").get();
    if (cls) {
      const res = await request(app).get(`/admin/rosters/print?tab=class-${cls.id}`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.match(res.text, new RegExp(cls.class_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  await t.test('a roster with more than 50 members splits into fixed 50-row print chunks, each with its own repeated header', async () => {
    const { ensureDayRoster } = require('../utils/classSchedule');
    const rosterId = await ensureDayRoster('wednesday', 'parent');
    for (let i = 1; i <= 60; i++) {
      const memberId = (
        await db
          .prepare(`INSERT INTO members (name, barcode, member_type) VALUES ('Print Page Member ${String(i).padStart(2, '0')}', 'print-page-member-${i}', 'parent') RETURNING id`)
          .get()
      ).id;
      await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterId, memberId);
    }

    const res = await request(app).get('/admin/rosters/print?tab=wednesday-parent').set('Cookie', cookie);
    assert.equal(res.status, 200);

    const chunks = res.text.split('roster-print-chunk').length - 1;
    assert.equal(chunks, 2, 'a 60-member roster should split into exactly 2 print chunks of up to 50 rows each');
    assert.equal((res.text.match(/Wednesday Parents Attendance Spreadsheet/g) || []).length, 2, 'each chunk repeats its own print header');

    const firstChunkEnd = res.text.indexOf('roster-print-chunk', res.text.indexOf('roster-print-chunk') + 1);
    const firstChunkHtml = res.text.slice(0, firstChunkEnd);
    const secondChunkHtml = res.text.slice(firstChunkEnd);
    assert.equal((firstChunkHtml.match(/<td class="roster-name-col">Print Page Member/g) || []).length, 50, 'first chunk holds 50 rows');
    assert.equal((secondChunkHtml.match(/<td class="roster-name-col">Print Page Member/g) || []).length, 10, 'second chunk holds the remaining 10 rows');
  });

  await t.test('the Playground log Print button links to the preview route with its own tab and selected date', async () => {
    const res = await request(app).get('/admin/rosters?tab=playground-monday-1').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/admin\/rosters\/print\?tab=playground-monday-1/);
  });

  await t.test('?tab=playground-monday-1 renders a read-only Playground log preview with a Print button', async () => {
    const res = await request(app).get('/admin/rosters/print?tab=playground-monday-1').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Monday Playground/);
    assert.match(res.text, /onclick="window\.print\(\)"/);
  });
});
