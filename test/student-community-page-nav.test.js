// Two real bug reports from the same root cause: "student portal, mobile.
// dashboard panel tab bar should still be on the bottom. its not visible
// on calendar page" and "there are two chat tabs on student portal.
// there should only be one." /events and /forums are shared "Community"
// pages every portal links into (not native /student/* routes), so they
// each pass their own portalTitle to partials/portal-nav.ejs instead of
// the centralized STUDENT_NAV_LINKS every other student page gets -
// events-list.ejs used the plain public site-header shell (no bottom tab
// bar at all), and forums-list.ejs/forums-category.ejs/forums-thread.ejs/
// forums-new-thread.ejs passed portalTitle:'Chat', which portal-nav.ejs
// doesn't special-case, so it fell through to the generic default
// communityLinks list (Events/Chat/Member Directory/...) stacked
// underneath that page's own explicit Chat link - a second, redundant
// "Chat" tab. Both now detect a signed-in student (portalRoles) and pass
// portalTitle:'Student Portal', the one value portal-nav.ejs itself maps
// straight to STUDENT_NAV_LINKS/the empty COMMUNITY_LINKS_STUDENT.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `student-community-nav-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `student-community-nav-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let studentCounter = 0;
async function loginAsStudent() {
  studentCounter++;
  const barcode = `nav-test-student-${studentCounter}`;
  const email = `nav-test-student-${studentCounter}@example.com`;
  const memberId = (
    await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run('Nav Test Student', barcode, 'student')
  ).lastInsertRowid;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'active')")
      .run(memberId, email, hashPassword('testpassword123'))
  ).lastInsertRowid;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const res = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return res.headers['set-cookie'];
}

function bottomTabLabels(html) {
  const match = html.match(/<nav class="admin-mobile-tabs"[\s\S]*?<\/nav>/);
  if (!match) return null;
  // A real request ("split the words into two rows to help shrink the
  // width of the tabs") renders some of these spans as e.g. "Reading<br>
  // Challenge" instead of plain text - [\s\S]*? (not [^<]+) still finds
  // the span, and the <br> -> space swap recovers the same plain label
  // this test already asserts on, same two-row split or not.
  return [...match[0].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<br\s*\/?>/gi, ' ').trim());
}

test('a signed-in student sees their own bottom tab bar on the Calendar page, not a missing one', async () => {
  const cookie = await loginAsStudent();
  const res = await request(app).get('/events?view=calendar').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const tabs = bottomTabLabels(res.text);
  assert.ok(tabs, 'the Calendar page should render the bottom tab bar for a signed-in student');
  // A later real request moved Classes to the 3rd tab and dropped
  // Assignments as its own standing tab (see routes/student-portal.js's
  // own /classes/dashboard comment - it's now one click away from every
  // Classroom Dashboard card instead). A still later real request split
  // Classes back into 2 standing tabs ("Class schedule should be its own
  // tab and called Co-op Schedule. Classroom dashboard should be its own
  // tab and the beginning of a new section") - Co-op Schedule stays in
  // the primary group, Classroom Dashboard moves to the end (the
  // previously-empty 3rd/"Classroom" section, appended into this same
  // scrollable bar per the mobile template's own comment).
  // A real request: "Student portal. Calendar should say events" -
  // matches Main Admin/Parent/Teacher, which all already said Events.
  assert.deepEqual(tabs, [
    'Home', 'Events', 'Co-op Schedule', 'Family Homeschooling', 'Chat', 'Resources', 'Photos', 'Babysitter Profile',
    'Games', 'Pet', 'Reading Challenge', 'Achievements', 'Leaderboard', 'Nature News', 'Vocabulary',
    'Classroom Dashboard',
  ]);
});

test('a logged-out visitor to the Calendar page still gets the plain public site header, not the student shell', async () => {
  const res = await request(app).get('/events?view=calendar');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /admin-mobile-tabs/, 'a signed-out visitor should never see a portal-specific bottom tab bar');
  assert.match(res.text, /site-header/, 'the public shell should still render');
});

test('a signed-in student sees their own bottom tab bar on the Chat page, with exactly one Chat tab', async () => {
  const cookie = await loginAsStudent();
  const res = await request(app).get('/forums').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const tabs = bottomTabLabels(res.text);
  assert.ok(tabs, 'the Chat page should render the bottom tab bar for a signed-in student');
  assert.equal(tabs.filter((t) => t === 'Chat').length, 1, 'exactly one Chat tab, not two');
  assert.deepEqual(tabs, [
    'Home', 'Events', 'Co-op Schedule', 'Family Homeschooling', 'Chat', 'Resources', 'Photos', 'Babysitter Profile',
    'Games', 'Pet', 'Reading Challenge', 'Achievements', 'Leaderboard', 'Nature News', 'Vocabulary',
    'Classroom Dashboard',
  ]);
  assert.doesNotMatch(res.text, /Member Directory/, 'the generic community list (Member Directory, Newsletter, ...) should not leak into a student\'s own nav');
});
