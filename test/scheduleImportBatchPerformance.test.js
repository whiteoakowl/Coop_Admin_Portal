// Real regression coverage for a live-reported production timeout:
// importing a member schedule spreadsheet (POST /schedule/members/import,
// memberType=student) with hundreds of rows failed with Netlify's own
// "Inactivity Timeout" before the request ever finished.
//
// Root cause, two compounding N+1s in the same loop:
//   1. The member lookup and the class lookup were both separate
//      sequential queries run once per row/slot - a real file (hundreds
//      of rows, up to SCHEDULE_SLOT_COUNT slots each) fired thousands of
//      tiny round trips at a real, network-latency-bound Postgres
//      connection.
//   2. Worse: for students, setEnrollment(classId, ids) was called once
//      PER MATCHED (student, class) PAIR, and setEnrollment's own shape
//      is "delete the class's whole current roster, then re-insert the
//      given list" - calling it once per student importing into the SAME
//      popular class meant the Nth student's import re-wrote all N-1
//      already-imported students' rows too, making a popular class's
//      import cost QUADRATIC in its own enrollment size, not linear.
//
// This can't measure wall-clock time reliably in a shared test
// environment, so it proves the actual invariants that matter instead:
// member/class lookups happen a FIXED number of times regardless of file
// size, and a class shared by many imported students gets its roster
// written ONCE, not once per student.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const testDbPath = path.join(os.tmpdir(), `schedule-import-batch-perf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-import-batch-perf-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

const SLOT_COUNT = 8;
const HEADERS = ['Member First Name', 'Member Last Name', 'Allergy'];
for (let i = 1; i <= SLOT_COUNT; i++) HEADERS.push(`Class Start Time ${i}`, `Class Title ${i}`, `Class Location ${i}`, `Class Days ${i}`);

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Counts calls to db.prepare() whose SQL matches `pattern`, for the
// duration of `fn`.
async function countQueries(pattern, fn) {
  const originalPrepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = (sql) => {
    if (pattern.test(sql)) count++;
    return originalPrepare(sql);
  };
  try {
    await fn();
  } finally {
    db.prepare = originalPrepare;
  }
  return count;
}

test('importing 60 students who all share one popular class writes that class\'s roster once, not once per student', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'monday', className: 'Popular Import Class', hourPosition: '1', color: '#EE9A4D', _csrf: csrfToken });

  const names = [];
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const firstName = `ImportPerf${i}`;
    const lastName = 'Student';
    names.push(`${firstName} ${lastName}`);
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(`${firstName} ${lastName}`, `import-perf-${i}`);
    const row = [firstName, lastName, ''];
    for (let s = 1; s <= SLOT_COUNT; s++) {
      row.push(s === 1 ? '10:00 AM' : '', s === 1 ? 'Popular Import Class' : '', '', s === 1 ? 'Mon' : '');
    }
    rows.push(row);
  }
  const buffer = buildImportBuffer(rows);

  // `SELECT student_id FROM class_enrollments WHERE class_id = ?` runs
  // twice, total, when setEnrollment is genuinely called for a class:
  // once as this route's own batched "what's already enrolled" check
  // (used to decide whether that class needs a write at all), once more
  // inside setEnrollment itself (utils/classSchedule.js's
  // syncClassRosterMembers, called after its transaction commits - its
  // own DELETE+reinsert runs on the transaction's dedicated connection,
  // not this shared one, so it isn't directly observable here the same
  // way). Before the fix, setEnrollment ran once PER STUDENT for a
  // shared class - 60 times, not the fixed 2 this asserts.
  const lookups = await countQueries(/SELECT student_id FROM class_enrollments WHERE class_id = \?/, async () => {
    const res = await request(app)
      .post(`/admin/schedule/members/import?_csrf=${csrfToken}`)
      .set('Cookie', cookie)
      .field('memberType', 'student')
      .attach('file', buffer, 'import.xlsx');
    const notice = new URL(res.headers.location, 'http://localhost').searchParams.get('notice');
    assert.match(notice, /Matched 60 schedule row/);
  });

  assert.equal(lookups, 2, `one shared class's roster should be read/written a fixed number of times for the whole import, not once per student (got ${lookups})`);

  const enrolledCount = (await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id WHERE c.class_name = ?').get('Popular Import Class')).c;
  assert.equal(Number(enrolledCount), 60);
  for (const name of names) {
    const member = await db.prepare('SELECT id FROM members WHERE name = ?').get(name);
    const enrolled = await db.prepare('SELECT 1 FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id WHERE c.class_name = ? AND ce.student_id = ?').get('Popular Import Class', member.id);
    assert.ok(enrolled, `${name} should be enrolled`);
  }
});

test('member and class lookups happen a fixed number of times per import, not once per row/slot', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'monday', className: 'Lookup Perf Class', hourPosition: '2', color: '#EE9A4D', _csrf: csrfToken });

  async function importRowCount(prefix, count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const firstName = `${prefix}${i}`;
      await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(`${firstName} Student`, `${prefix}-${i}`);
      const row = [firstName, 'Student', ''];
      for (let s = 1; s <= SLOT_COUNT; s++) {
        row.push(s === 1 ? '10:45 AM' : '', s === 1 ? 'Lookup Perf Class' : '', '', s === 1 ? 'Mon' : '');
      }
      rows.push(row);
    }
    const buffer = buildImportBuffer(rows);
    return countQueries(/SELECT id, name, medical_notes FROM members WHERE member_type|SELECT \* FROM classes$/, async () => {
      await request(app).post(`/admin/schedule/members/import?_csrf=${csrfToken}`).set('Cookie', cookie).field('memberType', 'student').attach('file', buffer, 'import.xlsx');
    });
  }

  const smallLookups = await importRowCount('lookupsmall', 5);
  const largeLookups = await importRowCount('lookuplarge', 50);

  assert.equal(smallLookups, largeLookups, `member/class lookup count must not scale with row count (5 rows: ${smallLookups}, 50 rows: ${largeLookups})`);
  assert.equal(smallLookups, 2, 'exactly one member lookup and one class lookup per import, regardless of file size');
});
