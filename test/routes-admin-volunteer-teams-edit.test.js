// Real HTTP-level coverage for a bug report this session: Floater Teams
// cards had their rank <select> and per-member remove trash icon always
// live (no view/edit distinction at all), and the hour title (e.g. "Hour
// 1") wasn't editable in the UI. Rebuilt with the same inline
// "unfreeze the card" edit-toggle pattern as Setup/Cleanup
// (test/routes-admin-setup-team-cards.test.js) - an Edit button reveals a
// Save/Cancel pair, enables the rank selects, reveals the remove trash
// icons, and enables the hour-title input, all at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteer-teams-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteer-teams-edit-test-uploads-${process.pid}`);
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

test('Floater Teams: 4 hour cards, rank/remove start locked, hour title is editable', async (t) => {
  const { cookie } = await loginAsAdmin();

  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Robin Floater', 'Robin Floater', 'parent')")
    .run();
  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const section = await db.prepare('SELECT id, position FROM volunteer_sections WHERE volunteer_list_id = ? ORDER BY position LIMIT 1').get(list.id);
  await db.prepare("INSERT INTO volunteer_members (volunteer_list_id, section_id, member_id, rank) VALUES (?, ?, ?, 'sometimes')").run(list.id, section.id, memberId);

  const res = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('exactly 4 hour cards render, in the wider floater-team-card-grid', () => {
    assert.match(res.text, /class="team-card-grid floater-team-card-grid"/);
    const cardMatches = res.text.match(/class="team-col edit-section"/g) || [];
    assert.equal(cardMatches.length, 4, 'expected one card per HOUR_POSITIONS entry');
  });

  await t.test('the hour-title input starts disabled and edit-toggle.js is loaded', () => {
    assert.match(res.text, /<input type="text" name="label" class="team-info-title team-info-title-input"[^>]*disabled/);
    assert.match(res.text, /<script src="\/js\/edit-toggle\.js">/);
  });

  await t.test('the rank select and the remove-member trash icon both start locked', () => {
    assert.match(res.text, /<select name="rank" class="team-member-rank-select" onchange="this\.form\.requestSubmit\(\)" disabled>/);
    assert.match(res.text, /members\/\d+\/remove[^]*?data-edit-toggle-reveal hidden/);
  });
});

test('POST /admin/volunteers/:day/teams/:sectionId/hour-label renames only that one hour', async (t) => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const sections = await db.prepare('SELECT id, position FROM volunteer_sections WHERE volunteer_list_id = ? ORDER BY position').all(list.id);
  const firstSection = sections[0];

  await t.test('renaming hour 1 does not reset the other hours to their defaults', async () => {
    // Give hour 2 a custom label first, so we can confirm it survives.
    await db.prepare("INSERT INTO class_schedule_hours (day, position, label) VALUES ('monday', 2, 'Custom Hour 2') ON CONFLICT(day, position) DO UPDATE SET label = excluded.label").run();

    const res = await request(app)
      .post(`/admin/volunteers/monday/teams/${firstSection.id}/hour-label`)
      .set('Cookie', cookie)
      .type('form')
      .send({ label: 'Morning Shift', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=Hour%20renamed/);

    const hour1 = await db.prepare("SELECT label FROM class_schedule_hours WHERE day = 'monday' AND position = ?").get(firstSection.position);
    assert.equal(hour1.label, 'Morning Shift');

    const hour2 = await db.prepare("SELECT label FROM class_schedule_hours WHERE day = 'monday' AND position = 2").get();
    assert.equal(hour2.label, 'Custom Hour 2', 'renaming one hour must not reset another hour back to its default');
  });

  await t.test('an unknown section id is rejected without touching the DB', async () => {
    const res = await request(app)
      .post('/admin/volunteers/monday/teams/999999/hour-label')
      .set('Cookie', cookie)
      .type('form')
      .send({ label: 'Should Not Save', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
  });
});
