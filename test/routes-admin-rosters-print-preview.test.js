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
// preview has no shrink script at all, so a long roster can flow across
// more than one physical page instead.
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
