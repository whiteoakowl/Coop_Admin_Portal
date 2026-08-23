// Real HTTP-level coverage for a print request: "printing the setup
// cleanup teams should be one team per page[,] reduced to fit one whole
// team card per page. header for each card in print should be more
// organized with information reduced to balance equal rows." Three
// checks: each team gets wrapped for the one-page-per-card treatment
// (public/js/print-shrink-to-fit.js does the actual real-browser shrink,
// covered separately by a live Playwright pass - not reproducible over
// plain HTTP), the shrink script itself is loaded, and the print-only
// balanced Leader/Time/Location meta row renders only the fields a team
// actually has set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-print-one-per-page-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-print-one-per-page-test-uploads-${process.pid}`);
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
  return { cookie };
}

test('Setup/Cleanup Teams manage page: one-team-per-page print wrapper + shrink script', async (t) => {
  const { cookie } = await loginAsAdmin();

  const { lastInsertRowid: leaderId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Leader', 'pat-leader-1', 'parent')")
    .run();
  const { lastInsertRowid: teamAId } = await db
    .prepare("INSERT INTO setup_teams (day, title, meeting_time, meeting_location) VALUES ('monday', 'Chairs & Tables', '9:00am', 'Front Lobby')")
    .run();
  await db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leaderId, teamAId);
  await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Bare Team')").run();

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('every team is wrapped in .team-print-page-fit with a print-time shrink budget', () => {
    const wrapperMatches = res.text.match(/<div class="team-print-page-fit" data-shrink-to-fit-on-print data-shrink-to-fit-budget="[^"]+">/g) || [];
    assert.equal(wrapperMatches.length, 2, 'expected one .team-print-page-fit wrapper per team');
  });

  await t.test('print-shrink-to-fit.js is loaded on this page', () => {
    assert.match(res.text, /<script src="\/js\/print-shrink-to-fit\.js">/);
  });

  await t.test('a team with a leader, time, and location renders all three in the print-only meta row', () => {
    const cardMatch = new RegExp(`team-edit-form-${teamAId}"[\\s\\S]*?<div class="team-print-meta">[\\s\\S]*?<\\/div>`).exec(res.text);
    assert.ok(cardMatch, 'expected the team-print-meta row for Chairs & Tables');
    assert.match(cardMatch[0], /Pat Leader/);
    assert.match(cardMatch[0], /9:00am/);
    assert.match(cardMatch[0], /Front Lobby/);
  });

  await t.test('a team with no leader/time/location renders an empty meta row - no stray icons/commas', async () => {
    const bareTeam = await db.prepare("SELECT id FROM setup_teams WHERE title = 'Bare Team'").get();
    const cardMatch = new RegExp(`team-edit-form-${bareTeam.id}"[\\s\\S]*?<div class="team-print-meta">([\\s\\S]*?)<\\/div>`).exec(res.text);
    assert.ok(cardMatch, 'expected the team-print-meta row for Bare Team');
    assert.doesNotMatch(cardMatch[1], /team-print-meta-item/);
  });
});
