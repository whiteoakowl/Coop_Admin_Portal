// A real user request: "Next to the member's name on the floater list,
// floater assignment dropdown menu, setup/cleanup assignments and setup
// and cleanup team list. If the member has a student ages two or under
// it will say (infant) next to their name." utils/members.js's
// hasInfantChild(memberId) already existed and was already wired into
// two of these four spots (Floater Teams list, the floater-chart-cards
// substitute dropdown) under an older "(child <=2)" label - this covers
// the wording change to "(infant)" there, plus extending the same flag
// to the two spots that never had it: Setup/Cleanup's own team list
// (admin-setup.ejs) and its Assignments cards (setup-assignment-
// cards.ejs), both driven by routes/admin-setup.js's teamsWithMembers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `infant-flag-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `infant-flag-test-uploads-${process.pid}`);
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

// 1 year old today, well within the "2 or under" cutoff, computed off
// the real clock (utils/dates.js's ageFromBirthday uses new Date(), not
// any session/roster date) rather than a hardcoded string that would
// silently stop being "2 or under" as real time passes.
function oneYearOldBirthday() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

test('the "(infant)" flag appears next to a parent\'s name in all four places', async () => {
  const cookie = await loginAsAdmin();

  const family = await db.prepare("INSERT INTO families (name) VALUES ('Infant Flag Family')").run();
  const parent = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Ivy Infant-Parent', 'infant-parent', 'parent', ?)")
    .run(family.lastInsertRowid);
  await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, birthday) VALUES ('Baby Infant-Child', 'infant-child', 'student', ?, ?)")
    .run(family.lastInsertRowid, oneYearOldBirthday());

  // 1) Floater Teams list.
  const day = 'monday';
  const list = await getListByDay(day);
  const sections = await sectionsForList(list.id);
  const hour1 = sections.find((s) => s.position === 1);
  await addMemberToSection(list.id, parent.lastInsertRowid, hour1.id);

  const teamsRes = await request(app).get(`/admin/volunteers/${day}/teams`).set('Cookie', cookie);
  assert.equal(teamsRes.status, 200);
  assert.match(teamsRes.text, /Ivy Infant-Parent[\s\S]{0,80}<span class="team-member-flag">\(infant\)<\/span>/, 'Floater Teams list should show (infant)');

  // 2) Floater assignment dropdown (the substitute/chart page) - needs a
  // permanent job in hour 1 AND an upcoming session date on the list, or
  // hourSections comes back empty and there's no dropdown to check at all.
  await createPermanentJob({ day, hourPosition: 1, title: 'Infant Flag Test Job', room: 'Room 1' });
  const date = futureMonday();
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, date);
  const manageRes = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  assert.equal(manageRes.status, 200);
  assert.match(manageRes.text, /Ivy Infant-Parent \([^)]*, infant\)/, 'Floater assignment dropdown should append ", infant" to the option text');

  // 3) Setup/Cleanup team list.
  const setupTeam = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Infant Flag Setup Team')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(setupTeam.lastInsertRowid, parent.lastInsertRowid);

  const setupManageRes = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(setupManageRes.status, 200);
  assert.match(
    setupManageRes.text,
    /Ivy Infant-Parent[\s\S]{0,80}<span class="team-member-flag">\(infant\)<\/span>/,
    'Setup/Cleanup team list should show (infant)'
  );

  // 4) Setup/Cleanup assignment cards.
  await db.prepare("INSERT INTO setup_dates (day, session_date) VALUES ('monday', ?)").run(date);
  const assignmentsRes = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(assignmentsRes.status, 200);
  assert.match(
    assignmentsRes.text,
    /Ivy Infant-Parent[\s\S]{0,80}<span class="team-member-flag">\(infant\)<\/span>/,
    'Setup/Cleanup Assignment cards should show (infant)'
  );
});
