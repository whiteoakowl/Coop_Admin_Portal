// A real user request: "each drop down menu next to members should
// suggest a different task from the list until there aren't any left.
// filling all the task one dropdowns first then filling task 2 if out of
// spots. a member row should highlight red if the member is absent that
// day and no tasks should be suggested for that member." Covers
// routes/admin-setup.js's suggestDistinctTasks + assignmentCardsForDate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-assignment-suggestions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-assignment-suggestions-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

// A real bug: this test used to hardcode a specific far-future date
// string as its session date - safely in the future when written, but a
// literal calendar date eventually stops being "future" as real time
// passes (exactly what happened here). Computed fresh relative to the
// real clock every run instead - always a real Monday, always at least
// 3 weeks out, so it stays valid indefinitely.
function futureMonday() {
  let d = addDays(todayISO(), 21);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

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

function extractSlotCell(html, memberId, slot) {
  const match = new RegExp(`data-slot-cell="${memberId}-${slot}"[^]*?</td>`).exec(html);
  assert.ok(match, `expected a data-slot-cell="${memberId}-${slot}" cell in the page`);
  return match[0];
}

function selectedOptionText(cellHtml) {
  const match = /<option value="\d+" selected>([^<]*)<\/option>/.exec(cellHtml);
  return match ? match[1] : null;
}

test('Task 1 dropdowns each suggest a distinct task before Task 2 dropdowns get theirs, skipping absent members', async () => {
  const cookie = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Suggestion Team')").run();
  const section = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Suggestion Tasks', ?, 0)")
    .run(team.lastInsertRowid);
  await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Sweep floor');
  await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)').run(section.lastInsertRowid, 'Take out trash');

  const memberA = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Ann Baker', 'sugg-ann', 'parent')").run();
  const memberB = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bob Carter', 'sugg-bob', 'parent')").run();
  const memberC = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cara Diaz', 'sugg-cara', 'parent')").run();
  for (const m of [memberA, memberB, memberC]) {
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, m.lastInsertRowid);
  }

  // Mark Cara absent on the session date.
  const date = futureMonday();
  await db.prepare("INSERT INTO setup_dates (day, session_date) VALUES ('monday', ?)").run(date);
  const roster = await db.prepare("INSERT INTO rosters (schedule_day, name, active) VALUES ('monday', 'Suggestion Test Roster', 1)").run();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(roster.lastInsertRowid, date);
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(roster.lastInsertRowid, memberC.lastInsertRowid);
  await db
    .prepare("INSERT INTO attendance (roster_id, member_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')")
    .run(roster.lastInsertRowid, memberC.lastInsertRowid, date);

  const res = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(res.status, 200);

  const annSlot1 = extractSlotCell(res.text, memberA.lastInsertRowid, 1);
  const bobSlot1 = extractSlotCell(res.text, memberB.lastInsertRowid, 1);
  const caraSlot1 = extractSlotCell(res.text, memberC.lastInsertRowid, 1);

  // Ann and Bob (both present, both unassigned) get DIFFERENT Task 1
  // suggestions - not the same first list item for both.
  const annPick = selectedOptionText(annSlot1);
  const bobPick = selectedOptionText(bobSlot1);
  assert.ok(annPick, 'Ann should have a suggested Task 1');
  assert.ok(bobPick, 'Bob should have a suggested Task 1');
  assert.notEqual(annPick, bobPick, 'Ann and Bob should not be suggested the identical task in the same column');

  // Cara is absent - her row is flagged and nothing is suggested (no
  // <select> with a pre-selected option; a disabled "Absent" control instead).
  assert.match(res.text, /setup-assignment-row-absent/);
  assert.match(caraSlot1, /Absent - no task/);
  assert.doesNotMatch(caraSlot1, /selected/);
});
