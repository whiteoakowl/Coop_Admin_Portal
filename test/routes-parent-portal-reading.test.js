// A real request: "mimic the same reading challenge tabs and pages for
// parent portal. their reading challenge will work across all a
// parents" - a SEPARATE reading challenge among parents themselves (not
// a view into their children's reading), reusing utils/reading.js the
// same way Student Portal's own /student/reading does, keyed off the
// signed-in parent's own member row instead of a student's.
// leaderboard()'s new memberType param is what keeps a parent's ranking
// scoped to other parents only, never mixing in student reading hours -
// the one piece of shared logic this feature actually changed, so it's
// the focus of the leaderboard test below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-portal-reading-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-portal-reading-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

// Mirrors exactly how a real parent account is provisioned (a members
// row + a member_accounts credential + the 'parent' role), then logs in
// through the real /login route so every test below exercises the same
// session/CSRF machinery a browser would.
async function createParentAndLogin(name, email) {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'parent', 1)")
    .run(name, `barcode-${email}`);
  const { lastInsertRowid: accountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'active')")
    .run(memberId, email, hashPassword('testpassword123'));
  const parentRoleId = (await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRoleId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

test('GET /parent/reading renders the Reading Challenge dashboard for the signed-in parent', async () => {
  const { cookie } = await createParentAndLogin('Reading Parent One', 'reading-parent-1@example.com');
  const res = await request(app).get('/parent/reading').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Reading Challenge/);
  assert.match(res.text, /No entries yet/);
  assert.match(res.text, /Parent Portal/);
});

test('POST /parent/reading/log saves an entry, and it shows up on the dashboard afterward', async () => {
  const { cookie } = await createParentAndLogin('Reading Parent Two', 'reading-parent-2@example.com');
  const page = await request(app).get('/parent/reading').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const logRes = await request(app)
    .post('/parent/reading/log')
    .set('Cookie', cookie)
    .type('form')
    .send({ book_title: 'The Hobbit', hours: '2', notes: 'Great read', log_date: new Date().toISOString().slice(0, 10), _csrf: csrfToken });
  assert.equal(logRes.status, 302);
  assert.match(logRes.headers.location, /\/parent\/reading\?notice=/);

  const after = await request(app).get('/parent/reading').set('Cookie', cookie);
  assert.match(after.text, /The Hobbit/);
  assert.match(after.text, /\+20 pts/); // 2 hours * 10 points/hour
});

test('POST /parent/reading/goal updates the signed-in parent\'s own weekly goal', async () => {
  const { cookie } = await createParentAndLogin('Reading Parent Three', 'reading-parent-3@example.com');
  const page = await request(app).get('/parent/reading').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const goalRes = await request(app)
    .post('/parent/reading/goal')
    .set('Cookie', cookie)
    .type('form')
    .send({ weekly_goal_hours: '10', _csrf: csrfToken });
  assert.equal(goalRes.status, 302);
  assert.match(goalRes.headers.location, /Weekly%20goal%20updated%20to%2010%20hours/);

  const after = await request(app).get('/parent/reading').set('Cookie', cookie);
  assert.match(after.text, /Goal: 10 hours/);
});

test('GET /parent/achievements renders the same badge grid as the Reading Challenge dashboard', async () => {
  const { cookie } = await createParentAndLogin('Reading Parent Four', 'reading-parent-4@example.com');
  const res = await request(app).get('/parent/achievements').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Achievements/);
  assert.match(res.text, /Bookworm/);
  assert.match(res.text, /Week Warrior/);
});

test('GET /parent/leaderboard ranks parents against other parents only, never mixing in a student\'s reading hours', async () => {
  const { cookie } = await createParentAndLogin('Leaderboard Parent', 'leaderboard-parent@example.com');
  const page = await request(app).get('/parent/reading').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post('/parent/reading/log')
    .set('Cookie', cookie)
    .type('form')
    .send({ book_title: 'Parent Book', hours: '3', log_date: new Date().toISOString().slice(0, 10), _csrf: csrfToken });

  // A student, logged directly against the shared reading_logs table
  // (no student-portal login needed for this check) with far more hours
  // than the parent above - if leaderboard() ever lost its memberType
  // scoping, this student would wrongly outrank the parent here.
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Leaderboard Student', 'leaderboard-student-barcode', 'student', 1)")
    .run();
  await db
    .prepare("INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, 'Student Book', 100, ?)")
    .run(studentId, new Date().toISOString().slice(0, 10));

  const res = await request(app).get('/parent/leaderboard').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Leaderboard Parent/);
  assert.doesNotMatch(res.text, /Leaderboard Student/, 'a student\'s reading hours must never appear on the parent leaderboard');
  assert.match(res.text, /\(You\)/);
});
