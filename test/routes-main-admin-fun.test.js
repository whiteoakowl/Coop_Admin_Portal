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

test('Main Admin sidebar: Nature News is now "Fun," an accordion group with 6 subpages', async () => {
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
  assert.match(group[1], /href="\/main-admin\/fun\/pets">Pets</);

  // Same subpages also reachable from the mobile orange-bar popup.
  assert.match(res.text, /<button type="button" class="mobile-tab-subpages-trigger" data-subpages-dialog="mobile-subpages-fun"/);
  const dialogMatch = /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-fun">([\s\S]*?)<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'Fun should have its own mobile popup dialog');
  assert.equal((dialogMatch[1].match(/class="view-tab"/g) || []).length, 6);
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

test('Student Reading Challenge admin page: divides students into grade-section cards with a top-student-per-section summary card', async () => {
  const cookie = await loginAsMainAdmin();
  async function addGradedStudent(name, barcode, gradeLevel, hours) {
    const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active, grade_level) VALUES (?, ?, 'student', 1, ?)").run(name, barcode, gradeLevel);
    await db.prepare('INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, 'Band Book', hours, '2027-01-01');
    return info.lastInsertRowid;
  }
  await addGradedStudent('PreK Student', 'GRD-1', 'Pre-K', 1);
  await addGradedStudent('Kinder Student', 'GRD-2', 'Kindergarten', 5);
  await addGradedStudent('First Grade Student', 'GRD-3', '1st', 2);
  await addGradedStudent('Third Grade Student', 'GRD-4', '3rd', 4);
  await addGradedStudent('Twelfth Grade Student', 'GRD-5', '12th Grade', 6);

  const res = await request(app).get('/main-admin/fun/reading-challenge/students').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // Each grade band renders its own card, in order, with its own students.
  assert.match(res.text, /<h2>Nursery - PreK<\/h2>/);
  assert.match(res.text, /<h2>K - 1st Grade<\/h2>/);
  assert.match(res.text, /<h2>2nd - 3rd Grade<\/h2>/);
  assert.match(res.text, /<h2>8th - 12th Grade<\/h2>/);
  const kBandSection = res.text.split('<h2>K - 1st Grade</h2>')[1].split('<div class="manage-section">')[0];
  assert.match(kBandSection, /Kinder Student/);
  assert.match(kBandSection, /First Grade Student/);
  assert.doesNotMatch(kBandSection, /PreK Student/);

  // The top-by-section card shows Kinder Student (5 hrs) as K-1's top, not
  // First Grade Student (2 hrs) - and Pre-K's own top is PreK Student.
  const topCard = res.text.split('<h2>Top Student By Grade Section</h2>')[1].split('</table>')[0];
  assert.match(topCard, /Nursery - PreK<\/td>\s*<td>PreK Student<\/td>/);
  assert.match(topCard, /K - 1st Grade<\/td>\s*<td>Kinder Student<\/td>/);
  assert.doesNotMatch(topCard, /First Grade Student/);
});

test('Student Reading Challenge admin page: a student with no grade on file lands in its own Ungraded card, excluded from the top-by-section summary', async () => {
  const cookie = await loginAsMainAdmin();
  const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)").run('No Grade Student', 'GRD-NG');
  await db.prepare('INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, 'Mystery Book', 9, '2027-01-01');

  const res = await request(app).get('/main-admin/fun/reading-challenge/students').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<h2>Ungraded<\/h2>/);
  const ungradedSection = res.text.split('<h2>Ungraded</h2>')[1];
  assert.match(ungradedSection, /No Grade Student/);
  const topCard = res.text.split('<h2>Top Student By Grade Section</h2>')[1].split('</table>')[0];
  assert.doesNotMatch(topCard, /No Grade Student/);
});

test('Parent Reading Challenge admin page: a Top 10 Adults By Hours card lists the highest-hours adults', async () => {
  const cookie = await loginAsMainAdmin();
  async function addParentWithHours(name, barcode, hours) {
    const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'parent', 1)").run(name, barcode);
    await db.prepare('INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, 'Adult Book', hours, '2027-01-01');
  }
  await addParentWithHours('Low Hours Parent', 'PAR-LOW', 1);
  await addParentWithHours('High Hours Parent', 'PAR-HIGH', 20);

  const res = await request(app).get('/main-admin/fun/reading-challenge/parents').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const topCard = res.text.split('<h2>Top 10 Adults By Hours</h2>')[1].split('</table>')[0];
  assert.ok(topCard, 'Top 10 Adults By Hours card should render');
  const highIndex = topCard.indexOf('High Hours Parent');
  const lowIndex = topCard.indexOf('Low Hours Parent');
  assert.ok(highIndex !== -1 && lowIndex !== -1 && highIndex < lowIndex, 'higher-hours adult should rank above a lower-hours one');
});

// A real request: "if a member is an admin they still have the same
// member privileges as a parent... can complete games, lessons,
// activities, anything" - an admin's own logged reading time should
// count on the Parent Reading Challenge page and its Top 10 Adults
// card exactly like a parent's, not be silently excluded.
test('Parent Reading Challenge admin page: an admin member counts as a parent, not excluded', async () => {
  const cookie = await loginAsMainAdmin();
  const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'admin', 1)").run('Reading Admin', 'ADM-READ');
  await db.prepare('INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, 'Admin Book', 15, '2027-01-01');

  const res = await request(app).get('/main-admin/fun/reading-challenge/parents').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Reading Admin/);
  const topCard = res.text.split('<h2>Top 10 Adults By Hours</h2>')[1].split('</table>')[0];
  assert.match(topCard, /Reading Admin/, 'an admin with logged hours should appear on the adults leaderboard card');
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

test('Pets admin page: read-only table of Student Portal pet activity', async () => {
  const cookie = await loginAsMainAdmin();
  const info = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)").run('Pets Test Student', 'PTS-1');
  const student = { id: info.lastInsertRowid, name: 'Pets Test Student' };
  await db.prepare('INSERT INTO student_pets (member_id, name, look, xp, coins) VALUES (?, ?, ?, ?, ?)').run(student.id, 'Fluffy', 'dog', 115, 40);

  const res = await request(app).get('/main-admin/fun/pets').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<td class="roster-name-col">${student.name}</td>`));
  assert.match(res.text, /<td>Fluffy<\/td>/);
  assert.match(res.text, /<td>Golden Retriever<\/td>/);
  assert.match(res.text, /<td>2<\/td>/);
  assert.match(res.text, /<td>15 \/ 100<\/td>/);
  assert.match(res.text, /<td>40<\/td>/);
});

test('Pets admin page: empty state when no pets exist yet', async () => {
  const cookie = await loginAsMainAdmin();
  await db.prepare('DELETE FROM student_pets').run();
  const res = await request(app).get('/main-admin/fun/pets').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No pets created yet\./);
});
