// Real bug report: "when floaters are removed from the floater list they
// should also disappear from the dropdown menu of suggested floaters on
// the assignment page." routes/admin-volunteers.js's manage page used to
// union in every OTHER active parent site-wide (activeParentOptions) as a
// second, unranked candidate tier below the real Floater List's own
// suggestions - so removing someone from the Floater List (utils/
// volunteers.js's removeMemberFromSection) never actually dropped them
// from the dropdown, they just fell into that unranked "everyone else"
// group. Every candidate offered now comes straight from
// hour.suggestedFloaters (utils/substitutes.js's substituteBoard, itself
// scoped to floaterMembersForHour) - the real Floater List for that exact
// hour, nothing broader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-dropdown-excludes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-dropdown-excludes-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection, removeMemberFromSection } = require('../utils/volunteers');
const { createPermanentJob } = require('../utils/substitutes');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

// routes/admin-volunteers.js's own GET /:day/manage only ever offers
// today-or-later dates (upcomingDates = dates.filter((d) => d >= today))
// - a hardcoded past date here would silently make the chart resolve
// zero rows regardless of what's actually assigned, which is exactly
// what happened once real "today" caught up to an earlier hardcoded
// date in this file. Finds the next actual Monday (today included) so
// this test keeps working indefinitely.
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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('a floater removed from the Floater List no longer appears in the assign dropdown, even though they\'re still an active parent', async () => {
  const { cookie } = await loginAsAdmin();
  const day = 'monday';
  const list = await getListByDay(day);
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  const staying = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Staying Floater', 'stay-floater', 'parent', 1)").run()).lastInsertRowid;
  const leaving = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Leaving Floater', 'leave-floater', 'parent', 1)").run()).lastInsertRowid;
  await addMemberToSection(list.id, staying, hour1.id);
  await addMemberToSection(list.id, leaving, hour1.id);
  // Removed before ever loading the page, so it's never the auto-picked
  // pending assignment either - the whole point is that an active parent
  // who ISN'T on the list (any more) shouldn't appear at all, not just
  // "unless they already got auto-picked."
  await removeMemberFromSection(list.id, leaving, hour1.id);

  await createPermanentJob({ day, hourPosition: 1, title: 'Dropdown Test Job', room: '' });

  // Give the day a session date so the chart actually resolves slots
  // (an unassigned job with no selectedDate renders no rows at all) -
  // must be today or later, see nextDateForWeekday's own comment above.
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, nextDateForWeekday(1)); // Monday

  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Staying Floater/, 'the still-on-the-list floater should be offered');
  assert.doesNotMatch(
    res.text,
    /Leaving Floater/,
    'a floater removed from the list must never appear in the dropdown - before this fix, every other active parent site-wide filled in as an unranked fallback tier'
  );
});
