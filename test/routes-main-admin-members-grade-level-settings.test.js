// Coverage for the Main Admin Portal > Members > Settings tab's new
// Grade Level Settings sub-tab (routes/main-admin-members.js's POST
// /settings/grade-levels, utils/gradeLevelSettings.js) - a real request:
// "Under member settings add a tab called grade level settings. Here is
// a list of graded levels. Next to each grade level is a date picker and
// another column for age. Clean rows. Each row will say, if student is
// (age), by (date/calendar picker), then they will be in (grade
// level)." Also covers the surrounding "All of these member settings
// are currently on one page. They should be moved to their own tabs" -
// the Settings tab's own nested settingsTab sub-tabs.
//
// A later real request ("Change settings to card style like the gear
// icon settings") replaced the in-page .view-tabs strip (and its
// "Grade Level Settings is the default" behavior) with a landing grid
// of cards - no settingsTab in the URL now shows that grid, not any one
// sub-tab's content, so every fetch below that needs a specific sub-
// tab's content asks for it explicitly via &settingsTab=... instead of
// relying on a default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-grade-level-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-grade-level-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Settings tab (no settingsTab) shows a card grid naming all 6 settings areas, no sub-tab content', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.match(page.text, /<div class="team-card-grid">/);
  assert.match(page.text, /Grade Level Settings/);
  assert.match(page.text, /Membership Fee &amp; Payment/);
  assert.match(page.text, /Membership Form Fields/);
  assert.match(page.text, /Approval\/Denial Messages/);
  assert.match(page.text, /Policy Handbook/);
  assert.match(page.text, /href="\/main-admin\/sections"[\s\S]*?Sections/);
  // No sub-tab's own content renders on the landing grid itself.
  assert.doesNotMatch(page.text, /name="gradeLevel"/);
  assert.doesNotMatch(page.text, /Approval Letter/);
});

test('settingsTab=grade-levels shows just that section, one row per grade level', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  assert.doesNotMatch(page.text, /<div class="team-card-grid">/);
  assert.match(page.text, /href="\/main-admin\/members\?tab=settings">&larr; Settings</);
  assert.match(page.text, /name="gradeLevel" value="Kindergarten"/);
  assert.match(page.text, /name="gradeLevel" value="1st"/);
  // The other sub-tabs' content isn't rendered until selected.
  assert.doesNotMatch(page.text, /Approval Letter/);
});

test('Switching settingsTab shows only that section', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=approval-denial').set('Cookie', cookie);
  assert.doesNotMatch(page.text, /<div class="team-card-grid">/);
  assert.match(page.text, /Approval Letter/);
  assert.match(page.text, /Denial Letter/);
  assert.doesNotMatch(page.text, /name="gradeLevel"/);
});

test('POST /main-admin/members/settings/grade-levels saves every row and redirects back to that sub-tab', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  const gradeLevels = [...page.text.matchAll(/name="gradeLevel" value="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(gradeLevels.includes('Kindergarten'));
  assert.ok(gradeLevels.includes('12th'));

  const age = gradeLevels.map((g) => (g === 'Kindergarten' ? '5' : g === '1st' ? '6' : ''));
  const cutoffDate = gradeLevels.map((g) => (g === 'Kindergarten' ? '2026-09-01' : g === '1st' ? '2026-09-01' : ''));

  const res = await request(app)
    .post('/main-admin/members/settings/grade-levels')
    .set('Cookie', cookie)
    .type('form')
    .send({ gradeLevel: gradeLevels, age, cutoffDate, _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /settingsTab=grade-levels/);
  assert.match(res.headers.location, /notice=/);

  const reloaded = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  const kRow = reloaded.text.split('name="gradeLevel" value="Kindergarten"')[1].split('</tr>')[0];
  assert.match(kRow, /value="5"/);
  assert.match(kRow, /value="2026-09-01"/);
});

test('Grade Level Settings tab offers an "Apply to All Members" action', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  assert.match(page.text, /<form method="POST" action="\/main-admin\/members\/settings\/grade-levels\/apply"/);
  assert.match(page.text, />\s*Apply to All Members\s*</);
});

// A real follow-up request: "Grade level settings under members should
// set the grade level for all members according to their birthday"
// (routes/main-admin-members.js's own POST /settings/grade-levels/apply,
// utils/gradeLevelSettings.js's own applyGradeLevelRulesToMembers).
test('POST /settings/grade-levels/apply sets each matching student\'s grade level from their birthday, leaves non-matches and non-students alone', async (t) => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  // Kindergarten: age 5 by 2026-09-01. 1st: age 6 by 2026-09-01.
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  const gradeLevels = [...page.text.matchAll(/name="gradeLevel" value="([^"]*)"/g)].map((m) => m[1]);
  const age = gradeLevels.map((g) => (g === 'Kindergarten' ? '5' : g === '1st' ? '6' : ''));
  const cutoffDate = gradeLevels.map((g) => (g === 'Kindergarten' || g === '1st' ? '2026-09-01' : ''));
  await request(app).post('/main-admin/members/settings/grade-levels').set('Cookie', cookie).type('form').send({ gradeLevel: gradeLevels, age, cutoffDate, _csrf: csrfToken });

  let seedCounter = 0;
  async function createStudent({ name, birthday, gradeLevel }) {
    seedCounter += 1;
    const code = `gradeapply${seedCounter}`;
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, birthday, grade_level, active) VALUES (?, ?, ?, 'student', ?, ?, 1)")
      .run(name, code, code, birthday || null, gradeLevel || null);
    return (await db.prepare('SELECT id FROM members WHERE barcode = ?').get(code)).id;
  }
  async function createParent(name) {
    seedCounter += 1;
    const code = `gradeapplyparent${seedCounter}`;
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)").run(name, code, code);
  }

  // Turns 5 on 2026-09-01 exactly - matches the Kindergarten rule.
  const kidId = await createStudent({ name: 'Grade Apply Kinder', birthday: '2021-09-01' });
  // Turns 6 on 2026-09-01 - matches 1st, but already has a DIFFERENT
  // grade level set by hand - should be overwritten to 1st.
  const firstId = await createStudent({ name: 'Grade Apply First', birthday: '2020-09-01', gradeLevel: '2nd' });
  // Already correctly Kindergarten - matched but not actually changed.
  const alreadyCorrectId = await createStudent({ name: 'Grade Apply Already Right', birthday: '2021-08-15', gradeLevel: 'Kindergarten' });
  // Age 10 by the cutoff date - no EXACT rule covers that age (only
  // Kindergarten=5 and 1st=6 are configured), but 1st is the closer of
  // the two (|10-6| < |10-5|), so this student should land on 1st
  // instead of staying Ungraded.
  const noExactMatchId = await createStudent({ name: 'Grade Apply No Exact Match', birthday: '2016-01-01', gradeLevel: '5th' });
  // No birthday on file at all - never considered, even though rules exist.
  const noBirthdayId = await createStudent({ name: 'Grade Apply No Birthday', birthday: null, gradeLevel: '3rd' });
  await createParent('Grade Apply Parent');

  const res = await request(app).post('/main-admin/members/settings/grade-levels/apply').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /settingsTab=grade-levels/);
  assert.match(decodeURIComponent(res.headers.location), /Updated 3 of 4 matching student\(s\)/);

  await t.test('a student matching Kindergarten gets it set', async () => {
    const row = await db.prepare('SELECT grade_level FROM members WHERE id = ?').get(kidId);
    assert.equal(row.grade_level, 'Kindergarten');
  });

  await t.test('a student matching 1st gets their old hand-set grade level overwritten', async () => {
    const row = await db.prepare('SELECT grade_level FROM members WHERE id = ?').get(firstId);
    assert.equal(row.grade_level, '1st');
  });

  await t.test('a student already matching their rule stays the same (counted as matched, not changed)', async () => {
    const row = await db.prepare('SELECT grade_level FROM members WHERE id = ?').get(alreadyCorrectId);
    assert.equal(row.grade_level, 'Kindergarten');
  });

  await t.test('a student whose age matches no exact rule lands on the closest configured one instead of staying Ungraded', async () => {
    const row = await db.prepare('SELECT grade_level FROM members WHERE id = ?').get(noExactMatchId);
    assert.equal(row.grade_level, '1st');
  });

  await t.test('a student with no birthday on file is never touched', async () => {
    const row = await db.prepare('SELECT grade_level FROM members WHERE id = ?').get(noBirthdayId);
    assert.equal(row.grade_level, '3rd');
  });
});
