// A real request: "Floater assignments, in the dropdown of members to
// choose for a position. Highlight them green if they have checked in."
// Same green already used for this exact signal on the Setup/Cleanup
// Assignments roster (utils/setup.js's own assignmentCardsForDate) -
// this reuses the identical checkedInMemberIdsForDate helper for the
// Floater Assignments chart's own assign dropdown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-checked-in-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-checked-in-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
const { createPermanentJob } = require('../utils/substitutes');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

function nextDateForWeekday(targetDay) {
  let date = todayISO();
  while (weekdayOf(date) !== targetDay) date = addDays(date, 1);
  return date;
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

test('the assign dropdown highlights a checked-in floater (CSS class + "checked in" text), not one who has not checked in', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const list = await getListByDay(day);
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  const checkedIn = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Checked In Floater', 'checked-in-floater', 'parent', 1)").run()
  ).lastInsertRowid;
  const notCheckedIn = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Not Checked In Floater', 'not-checked-in-floater', 'parent', 1)").run()
  ).lastInsertRowid;
  await addMemberToSection(list.id, checkedIn, hour1.id);
  await addMemberToSection(list.id, notCheckedIn, hour1.id);

  await createPermanentJob({ day, hourPosition: 1, title: 'Checked-In Test Job', room: '' });

  const sessionDate = nextDateForWeekday(1); // Monday
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, sessionDate);

  const parentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, ?, 'present', 'manual', ?)")
    .run(checkedIn, parentRoster.id, sessionDate, Date.now());

  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="\d+"\s*class="floater-option-checked-in">\s*Checked In Floater \([^)]*, checked in\)/);
  assert.doesNotMatch(res.text, /Not Checked In Floater \([^)]*, checked in\)/);
});
