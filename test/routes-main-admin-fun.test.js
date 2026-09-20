// Coverage for a real request: "nature news should be titled fun. Then
// nature news should be a page under that tab. Also, these subpages,
// student reading challenge, parent reading challenge, games, vocabulary
// game. These subpages are the admin side to these pages that are on the
// parent and student portal already," scoped to "simple read-only
// views" (see routes/main-admin-fun.js's own header comment).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-fun-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-fun-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Main Admin sidebar: Nature News is now "Fun," an accordion group with 5 subpages', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<use href="#icon-sprout"\/><\/svg> Nature News</);
  const group = /<details class="admin-nav-group">\s*<summary>[\s\S]*?Fun[\s\S]*?<\/summary>\s*<div class="admin-nav-subpages">([\s\S]*?)<\/div>\s*<\/details>/.exec(res.text);
  assert.ok(group, 'Fun should render as an accordion group');
  assert.match(group[1], /href="\/main-admin\/nature-news">Nature News</);
  assert.match(group[1], /href="\/main-admin\/fun\/reading-challenge\/students">Student Reading Challenge</);
  assert.match(group[1], /href="\/main-admin\/fun\/reading-challenge\/parents">Parent Reading Challenge</);
  assert.match(group[1], /href="\/main-admin\/fun\/games">Games</);
  assert.match(group[1], /href="\/main-admin\/fun\/vocabulary-game">Vocabulary Game</);

  // Same subpages also reachable from the mobile orange-bar popup.
  assert.match(res.text, /<button type="button" class="mobile-tab-subpages-trigger" data-subpages-dialog="mobile-subpages-fun"/);
  const dialogMatch = /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-fun">([\s\S]*?)<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'Fun should have its own mobile popup dialog');
  assert.equal((dialogMatch[1].match(/class="view-tab"/g) || []).length, 5);
});

test('Student Reading Challenge admin page: table of all active students\' reading hours/points/goal', async () => {
  const cookie = await loginAsMainAdmin();
  const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)").run('Reading Test Student', 'RTS-1');
  const student = { id: info.lastInsertRowid, name: 'Reading Test Student' };
  await db.prepare('INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, ?, ?, ?)').run(student.id, 'A Wrinkle in Time', 3, '2027-01-01');

  const res = await request(app).get('/main-admin/fun/reading-challenge/students').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<td class="roster-name-col">${student.name}</td>`));
  assert.match(res.text, /<td>3\.0<\/td>/);
  assert.match(res.text, /<td>30<\/td>/);
});

test('Parent Reading Challenge admin page: same data, grouped by family', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/fun/reading-challenge/parents').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Parent Reading Challenge/);
});

test('Games admin page: top score per game + recent activity', async () => {
  const cookie = await loginAsMainAdmin();
  const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)").run('Games Test Student', 'GTS-1');
  const student = { id: info.lastInsertRowid, name: 'Games Test Student' };
  await db.prepare('INSERT INTO game_plays (member_id, game_key) VALUES (?, ?)').run(student.id, 'snake');
  await db.prepare('INSERT INTO game_scores (member_id, game_key, score) VALUES (?, ?, ?)').run(student.id, 'snake', 42);

  const res = await request(app).get('/main-admin/fun/games').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Snake/);
  assert.match(res.text, /<td>42<\/td>/);
  assert.match(res.text, new RegExp(`<td class="roster-name-col">${student.name}</td>`));
});

test('Vocabulary Game admin page: top players + read-only hardcoded word lists', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/fun/vocabulary-game').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Elementary Word List/);
  assert.match(res.text, /Middle School Word List/);
  assert.match(res.text, /High School Word List/);
  assert.match(res.text, /<td class="roster-name-col">because<\/td>/);
});
