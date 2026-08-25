// Real HTTP-level coverage for a bug report this session: the Setup/
// Cleanup team cards' Edit button used to open a separate popup dialog
// (title/description/leader/members/delete all living in there) instead
// of editing the card the admin is already looking at. Rebuilt as an
// inline "unfreeze the card" edit (public/js/edit-toggle.js, shared with
// the same pattern on views/admin-settings.ejs and, going forward,
// Floater Teams): title/description/leader start disabled, the
// delete-team trash icon and every member row's remove trash icon start
// hidden, and clicking Edit turns all of that on in place - no popup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-team-cards-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-team-cards-test-uploads-${process.pid}`);
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

test('Setup/Cleanup team card: inline edit-in-place markup, no popup dialog', async (t) => {
  const { cookie } = await loginAsAdmin();

  const { lastInsertRowid: teamId } = await db
    .prepare("INSERT INTO setup_teams (day, title, description) VALUES ('monday', 'Chairs & Tables', 'Set up folding chairs')")
    .run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Volunteer', 'Pat Volunteer', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('the card is one edit-toggle .edit-section, not a popup dialog', () => {
    assert.match(res.text, /class="team-col edit-section"/);
    assert.doesNotMatch(res.text, /id="edit-team-dialog-/, 'the old per-team Edit popup dialog should be gone');
    assert.match(res.text, /<script src="\/js\/edit-toggle\.js">/);
  });

  await t.test('title/description/leader fields start disabled', () => {
    const titleInputMatch = /<input type="text" name="title" class="[^"]*" value="Chairs &amp; Tables"[^>]*>/.exec(res.text);
    assert.ok(titleInputMatch, 'expected the title <input>');
    assert.match(titleInputMatch[0], /\bdisabled\b/);

    const descInputMatch = /<input type="text" name="description" class="team-info-desc-input" value="Set up folding chairs"[^>]*>/.exec(res.text);
    assert.ok(descInputMatch, 'expected the description <input>');
    assert.match(descInputMatch[0], /\bdisabled\b/);

    assert.match(res.text, /<select name="leaderId" class="team-info-leader-select" disabled>/);
  });

  await t.test('the delete-team trash icon and the member remove trash icon both start hidden', () => {
    assert.match(res.text, /teams\/\d+\/delete[^]*?data-edit-toggle-reveal hidden/);
    assert.match(res.text, /data-edit-toggle-reveal hidden data-member-remove-btn/);
  });

  await t.test('the Save button is wired to the team-edit-form via the form= attribute, not physically nested inside it', () => {
    // A <form> can't nest inside another <form> (browser drops the inner
    // tag) - the corner-actions Save button lives outside
    // #team-edit-form-<id> and targets it by id instead. See public/js/
    // member-form.js's own comment on this exact same HTML constraint.
    assert.match(res.text, new RegExp(`form="team-edit-form-${teamId}" data-edit-toggle-save`));
  });
});

test('POST /admin/setup/:day/teams/:teamId/edit still saves title/description/leader together', async (t) => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  const csrfMatch = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Original Title')").run();

  await t.test('saving updates the team row', async () => {
    const res = await request(app)
      .post(`/admin/setup/monday/teams/${teamId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Renamed Title', description: 'New description', leaderId: '', _csrf: csrfToken });
    assert.equal(res.status, 302);
    const row = await db.prepare('SELECT title, description FROM setup_teams WHERE id = ?').get(teamId);
    assert.equal(row.title, 'Renamed Title');
    assert.equal(row.description, 'New description');
  });
});

// A real request: "setup/cleanup team cards should have a space for time
// to meet and meeting location."
test('Setup/Cleanup team card: create/edit save meeting time and location, and the card shows them once set', async (t) => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  const csrfMatch = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;

  await t.test('the Create New Team dialog offers meeting time/location fields', () => {
    assert.match(page.text, /<input type="text" name="meetingTime" placeholder="Meeting time \(optional\)" \/>/);
    assert.match(page.text, /<input type="text" name="meetingLocation" placeholder="Meeting location \(optional\)" \/>/);
  });

  await t.test('creating a team saves meeting time/location', async () => {
    const res = await request(app)
      .post('/admin/setup/monday/teams')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Snack Table', meetingTime: '9:00am', meetingLocation: 'Front Lobby', _csrf: csrfToken });
    assert.equal(res.status, 302);
    const row = await db.prepare("SELECT meeting_time AS \"meetingTime\", meeting_location AS \"meetingLocation\" FROM setup_teams WHERE title = 'Snack Table'").get();
    assert.equal(row.meetingTime, '9:00am');
    assert.equal(row.meetingLocation, 'Front Lobby');
  });

  await t.test('the team card shows a disabled meeting time/location field, pre-filled', async () => {
    const managePage = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
    assert.match(managePage.text, /<input type="text" name="meetingTime" class="team-info-meeting-input" value="9:00am" placeholder="Meeting time" disabled \/>/);
    assert.match(managePage.text, /<input type="text" name="meetingLocation" class="team-info-meeting-input" value="Front Lobby" placeholder="Meeting location" disabled \/>/);
  });

  await t.test('editing a team updates meeting time/location', async () => {
    const team = await db.prepare("SELECT id FROM setup_teams WHERE title = 'Snack Table'").get();
    const res = await request(app)
      .post(`/admin/setup/monday/teams/${team.id}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Snack Table', leaderId: '', meetingTime: '9:30am', meetingLocation: 'Side Room', _csrf: csrfToken });
    assert.equal(res.status, 302);
    const row = await db.prepare("SELECT meeting_time AS \"meetingTime\", meeting_location AS \"meetingLocation\" FROM setup_teams WHERE id = ?").get(team.id);
    assert.equal(row.meetingTime, '9:30am');
    assert.equal(row.meetingLocation, 'Side Room');
  });
});

// A real bug report: "on the setup/cleanup team cards its showing the
// information circled twice. reduce and clean this up with a
// professional looking layout, clean, balanced." Root cause was a stale
// cached stylesheet on the reporting device (public/sw.js's own comment
// covers that - not something an HTTP-level test can exercise), but the
// screen layout itself also got tightened up while fixing this: Leader/
// Meeting time/Meeting location now share one flex-wrap
// .team-info-meta-row instead of three separate full-width stacked
// rows, and the leader field dropped its spelled-out "Leader:" label in
// favor of the same icon-only convention print's own .team-print-meta
// chip already used.
test('Setup/Cleanup team card: Leader/Meeting time/Meeting location share one balanced row, not three stacked ones', async (t) => {
  const { cookie } = await loginAsAdmin();

  const leader = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Row Leader', 'row-leader-1', 'parent')").run();
  const withMeta = await db
    .prepare("INSERT INTO setup_teams (day, title, meeting_time, meeting_location) VALUES ('monday', 'Row Team', '9:00am', 'Front Lobby')")
    .run();
  await db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leader.lastInsertRowid, withMeta.lastInsertRowid);

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('a team with a leader, time, and location has all three inside one .team-info-meta-row wrapper', () => {
    const rowMatch = new RegExp(`team-edit-form-${withMeta.lastInsertRowid}"[\\s\\S]*?<div class="team-info-meta-row">([\\s\\S]*?)</div>\\s*</form>`).exec(res.text);
    assert.ok(rowMatch, 'expected a .team-info-meta-row wrapping the leader/meeting fields');
    assert.match(rowMatch[1], /team-info-leader/);
    assert.match(rowMatch[1], /name="meetingTime"/);
    assert.match(rowMatch[1], /name="meetingLocation"/);
  });

  await t.test('the leader field no longer spells out "Leader:" - icon + select only, matching the print chip\'s own convention', () => {
    assert.doesNotMatch(res.text, />\s*Leader:\s*</);
  });
});

// A real request: "admins and parents should show up in the dropdown
// menu for setup/cleanup team member lists" - clarified afterward to
// mean specifically "choosing a leader for setup/cleanup [team]s", so
// BOTH leader dropdowns (the standing team card's own, and the Create
// New Team dialog's) picked up admin members alongside parents first
// (utils/members.js's activeParentAndAdminOptions). A later, broader
// request - "admins should still be included in lists of members/
// parents etc. for selecting ANYTHING across the site" - widened the
// Add Member dialog's own picker the same way: admins are regularly
// hands-on team members too, not just leaders.
test('Setup/Cleanup manage page: admins show up alongside parents both when choosing a team leader and in the Add Member picker', async (t) => {
  const { cookie } = await loginAsAdmin();

  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Parent', 'Pat Parent', 'parent')").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Ashley Admin', 'Ashley Admin', 'admin')").run();
  // A student is neither - should never show up in any of these pickers.
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sam Student', 'Sam Student', 'student')").run();

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);

  await t.test('the Create New Team dialog\'s leader dropdown offers both parents and admins', () => {
    const dialogMatch = /<dialog id="new-team-dialog"[\s\S]*?<\/dialog>/.exec(res.text);
    assert.ok(dialogMatch, 'expected the Create New Team dialog');
    assert.match(dialogMatch[0], /<option value="\d+">Pat Parent<\/option>/);
    assert.match(dialogMatch[0], /<option value="\d+">Ashley Admin<\/option>/);
    assert.doesNotMatch(dialogMatch[0], /Sam Student/);
  });

  await t.test('the Add Member dialog\'s member picker also offers both parents and admins', () => {
    const dialogMatch = /<dialog id="add-member-dialog"[\s\S]*?<\/dialog>/.exec(res.text);
    assert.ok(dialogMatch, 'expected the Add Member dialog');
    assert.match(dialogMatch[0], /<option value="\d+">Pat Parent<\/option>/);
    assert.match(dialogMatch[0], /<option value="\d+">Ashley Admin<\/option>/);
    assert.doesNotMatch(dialogMatch[0], /Sam Student/);
  });

  await t.test('an existing team card\'s own leader dropdown offers both parents and admins', async () => {
    await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Snack Table 2')").run();
    const managePage = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
    const selectMatch = /<select name="leaderId" class="team-info-leader-select" disabled>[\s\S]*?<\/select>/.exec(managePage.text);
    assert.ok(selectMatch, 'expected a team card leader <select>');
    assert.match(selectMatch[0], /Pat Parent/);
    assert.match(selectMatch[0], /Ashley Admin/);
    assert.doesNotMatch(selectMatch[0], /Sam Student/);
  });
});
