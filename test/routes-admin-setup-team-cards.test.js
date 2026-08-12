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
    assert.match(res.text, /remove-member\/\d+[^]*?data-edit-toggle-reveal hidden/);
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
