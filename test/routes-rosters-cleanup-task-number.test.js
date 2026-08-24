// Feature: the Monday/Wednesday Attendance roster shows each member's
// suggested Setup/Cleanup task (Setup/Cleanup > Assignments tab, see
// setup_task_assignments' own schema comment) as a tiny "<team name>-#<n>"
// print tucked under the P/A/L status circle - same .cell-time treatment
// as the check-in/out times (see routes-rosters-cell-time-layout.test.js),
// so it never widens the date column. <n> is the task's own display
// "Number" - its 1-indexed position within its section (utils/taskList.js's
// itemsForSection) - not its permanent id/barcode, so it always matches
// what the Task List page itself shows for that task. <team name> is
// whichever the section's own linked setup_teams row is titled, falling
// back to the section's own title when unlinked - the same resolution
// utils/taskList.js's badgeContextForSection already uses for printed
// task badges (a real request: "instead of it just being #3 [...] it
// should say Team 1-#3. the #3 would represent the task number from that
// team the member completed").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `rosters-cleanup-task-number-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `rosters-cleanup-task-number-test-uploads-${process.pid}`);
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

// Sets up a section with 8 ordered items and assigns a member the LAST one
// (so its display Number is 8, not its raw id) for the given session date.
// teamId, when given, links the section to a real setup_teams row - the
// cleanup label should then use that TEAM's own title, not the section's.
async function assignEighthTask(memberId, day, sessionDate, teamId) {
  const sectionId = (await db.prepare('INSERT INTO task_list_sections (day, title, team_id) VALUES (?, ?, ?)').run(day, 'Snack Table Team', teamId || null)).lastInsertRowid;
  let targetItemId;
  for (let i = 0; i < 8; i++) {
    const itemId = (await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, ?)').run(sectionId, `Task ${i + 1}`, i)).lastInsertRowid;
    if (i === 7) targetItemId = itemId;
  }
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run(day, sessionDate);
  await db.prepare('INSERT INTO setup_task_assignments (day, member_id, session_date, task_item_id) VALUES (?, ?, ?, ?)').run(day, memberId, sessionDate, targetItemId);
}

test('the live Attendance grid shows the member\'s assigned task as tiny "Snack Table Team-#8" under the status circle', async () => {
  const { cookie } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cleanup Task Student', 'cleanup-task-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-02-02';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await assignEighthTask(memberId, 'monday', today);

  const res = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Cleanup Task Student/);

  const wrapperRe = /<div class="cell-detailed">\s*<select class="roster-cell-select[^]*?<\/select>\s*<span class="print-only-tag[^]*?<\/span>\s*<span class="cell-time">In [^<]*<\/span>\s*<span class="cell-time">Snack Table Team-#8<\/span>\s*<\/div>/;
  assert.match(
    res.text,
    wrapperRe,
    'the assigned task\'s display Number (8, its position in the section) and the section\'s own title (this section is not linked to a real team) should render as tiny "Snack Table Team-#8" inside .cell-detailed, right after the check-in/out times'
  );
});

test('when the section IS linked to a real Setup/Cleanup team, the label uses the TEAM\'s own title, not the section\'s', async () => {
  const { cookie } = await loginAsAdmin();

  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Kitchen Crew')").run()).lastInsertRowid;
  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Team Linked Cleanup Student', 'team-linked-cleanup-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-03-02';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await assignEighthTask(memberId, 'monday', today, teamId);

  const res = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // Scoped to just this member's own row - the earlier test in this file
  // shares the same roster/page and legitimately has its own real
  // "Snack Table Team-#8" line for ITS unlinked section, so a page-wide
  // doesNotMatch would be a false negative (see the "no assignment" test
  // above's own comment for the same pattern).
  const rowStart = res.text.indexOf('Team Linked Cleanup Student');
  const rowEnd = res.text.indexOf('</tr>', rowStart);
  const rowHtml = res.text.slice(rowStart, rowEnd);
  assert.match(rowHtml, /Kitchen Crew-#8/, 'the linked team\'s own title ("Kitchen Crew") should be used, not the task list section\'s own title ("Snack Table Team")');
  assert.doesNotMatch(rowHtml, /Snack Table Team-#8/);
});

test('a member with no Setup/Cleanup assignment for that date shows no "Cleanup #" line', async () => {
  const { cookie } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Cleanup Task Student', 'no-cleanup-task-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-02-09';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());

  const res = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No Cleanup Task Student/);

  // Scoped to just this member's own row - other tests in this file share
  // the same roster/page and do have a real "Cleanup #" line elsewhere on
  // it, so a page-wide doesNotMatch would be a false negative.
  const rowStart = res.text.indexOf('No Cleanup Task Student');
  const rowEnd = res.text.indexOf('</tr>', rowStart);
  const rowHtml = res.text.slice(rowStart, rowEnd);
  assert.doesNotMatch(rowHtml, /Cleanup #/, 'no assignment for this date means no "Cleanup #" line in this member\'s own row');
});

test('the roster CSV export includes a "Cleanup #" column with the assigned task\'s display Number', async () => {
  const { cookie } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('CSV Cleanup Student', 'csv-cleanup-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-02-16';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await assignEighthTask(memberId, 'monday', today);

  const res = await request(app).get('/admin/roster/monday-student/export.csv').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const bom = String.fromCharCode(0xfeff);
  const lines = res.text.replace(new RegExp('^' + bom), '').split('\n');
  const header = lines[0].split(',').map((f) => f.replace(/^"|"$/g, ''));
  const cleanupColIndex = header.indexOf('2026-02-16 Cleanup #');
  assert.notEqual(cleanupColIndex, -1, 'the CSV header should have a "2026-02-16 Cleanup #" column');

  const memberRow = lines.find((l) => l.includes('CSV Cleanup Student'));
  const fields = memberRow.split(',').map((f) => f.replace(/^"|"$/g, ''));
  assert.equal(fields[cleanupColIndex], '8', 'the row should carry the assigned task\'s display Number (8) in that date\'s Cleanup # column');
});

test('an archived roster keeps the "<team>-#" line in its frozen snapshot', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'monday' AND name LIKE '%Student%'").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Cleanup Student', 'archive-cleanup-student', 'student')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-02-23';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());
  await assignEighthTask(memberId, 'monday', today);

  await request(app).post('/admin/rosters/monday/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const archive = await db.prepare("SELECT id FROM roster_archives WHERE day = 'monday' ORDER BY id DESC LIMIT 1").get();
  const res = await request(app).get(`/admin/rosters/archive/${archive.id}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Archive Cleanup Student/);
  assert.match(res.text, /Snack Table Team-#8/, 'the archived snapshot must keep the assigned task\'s display Number and team label');
});
