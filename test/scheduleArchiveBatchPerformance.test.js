// Real regression coverage for a live-reported production timeout:
// archiving every student across all pages of a large Student Schedules
// list (the Select All pagination fix in this same session made that
// batch genuinely reach every member, not just the first page - see
// test/routes-schedule-archive-select-all-pagination.test.js) started
// timing out against a real, network-latency-bound Postgres connection
// (Netlify's own function timeout, not a local/PGlite-only limit).
//
// Root cause: archiveMemberSchedules used to call getMemberSchedule(id)
// once PER member being archived, and that function redoes each day's
// ENTIRE live computation (every class's enrollment/staffing, every
// floater section - see liveMemberScheduleRowsForDay) from scratch on
// every call. Archiving N members meant N full-day recomputations
// instead of the 2 (one per day) that are actually needed - exactly the
// same shape of N+1 already fixed once for Arrival/Departure
// (arrivalDepartureLabelsForMembers) but never applied here.
//
// This can't measure wall-clock time reliably in a shared test
// environment, so it proves the actual invariant that matters instead:
// the number of times the whole day gets recomputed (SELECT * FROM
// classes WHERE day = ?, liveMemberScheduleRowsForDay's own entry query)
// must stay CONSTANT (2 - once per day) no matter how many members are
// in the batch, not scale with batch size.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-archive-batch-perf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-archive-batch-perf-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { archiveMemberSchedules } = require('../utils/schedule');

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

// Counts how many times db.prepare() is called with SQL matching
// `FROM classes WHERE day` - liveMemberScheduleRowsForDay's own entry
// query, and the one thing that's expensive to redo per member (it reads
// every class, then loops enrollment/staffing/floater data for each).
async function countDayScans(fn) {
  const originalPrepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = (sql) => {
    if (sql.includes('FROM classes WHERE day')) count++;
    return originalPrepare(sql);
  };
  try {
    await fn();
  } finally {
    db.prepare = originalPrepare;
  }
  return count;
}

async function seedStudentsWithClasses(cookie, csrfToken, batchLabel, count) {
  // A handful of real Monday classes for these students to actually be
  // enrolled in - an empty schedule would make this test trivially pass
  // for the wrong reason (nothing to compute either way).
  const classIds = [];
  for (let hourPosition = 1; hourPosition <= 2; hourPosition++) {
    const className = `Perf Test Class ${batchLabel} ${hourPosition}`;
    await request(app)
      .post('/admin/class-schedule/classes/new')
      .set('Cookie', cookie)
      .type('form')
      .send({ day: 'monday', className, hourPosition: String(hourPosition), color: '#EE9A4D', _csrf: csrfToken });
    // Look the class back up by name to get its real id (the create route redirects, doesn't return one directly).
    const cls = await db.prepare('SELECT id FROM classes WHERE class_name = ?').get(className);
    classIds.push(cls.id);
  }

  const studentIds = [];
  for (let i = 0; i < count; i++) {
    const id = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')")
        .run(`PerfTest ${batchLabel} Student${i}`, `perftest-${batchLabel}-student-${i}`)
    ).lastInsertRowid;
    studentIds.push(id);
  }
  // Spread enrollment across both classes so the day's own live computation has real work to do either way.
  for (const classId of classIds) {
    await db.prepare(`INSERT INTO class_enrollments (class_id, student_id) VALUES ${studentIds.map(() => '(?, ?)').join(', ')}`).run(
      ...studentIds.flatMap((id) => [classId, id])
    );
  }
  return studentIds;
}

test('archiving a batch of members recomputes each day\'s live schedule ONCE, not once per member - the actual fix for a live production timeout', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const small = await seedStudentsWithClasses(cookie, csrfToken, 'small', 5);
  const smallScans = await countDayScans(() => archiveMemberSchedules(small));

  const large = await seedStudentsWithClasses(cookie, csrfToken, 'large', 60);
  const largeScans = await countDayScans(() => archiveMemberSchedules(large));

  // The actual regression to guard: the day-scan count must not grow
  // with batch size (5 members vs 60) - a handful of scans is expected
  // either way (liveMemberScheduleRowsForDay itself, plus the post-write
  // syncClassRosterMembers/syncDayMemberRosters resync each legitimately
  // reading the day back once), but that handful stays fixed regardless
  // of how many members are in the batch. Before the fix, archiving 60
  // members would have shown roughly 12x the small batch's count (one
  // full pair of day-scans PER member via the old getMemberSchedule(id)
  // call), not an equal number.
  assert.equal(smallScans, largeScans, `day-scan count must not scale with batch size (5 members: ${smallScans} scans, 60 members: ${largeScans} scans)`);
  assert.ok(smallScans > 0 && smallScans <= 10, `expected a small, fixed number of day-scans per archive call, got ${smallScans}`);

  const archivedCount = (await db.prepare('SELECT COUNT(*) AS c FROM member_schedule_archives').get()).c;
  assert.equal(Number(archivedCount), 65);
});
