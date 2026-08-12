// Coverage for the Setup/Cleanup Task List tab (routes/admin-setup.js's
// /setup/:day/tasks* routes, backed by utils/taskList.js), added while
// converting both to async/await as part of the Supabase migration (see
// MIGRATION.md) - this sub-feature had no test coverage before this.
// Runs against the still-live SQLite backend (await on a non-Promise
// value is a transparent pass-through), so this suite doubles as proof
// the conversion didn't change behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-tasks-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-tasks-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/setup/monday/tasks').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Setup/Cleanup Task List', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('creating a list, adding two tasks, and reordering them all persist', async () => {
    await request(app)
      .post('/admin/setup/monday/tasks/new')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Chairs & Tables', _csrf: csrfToken });

    const section = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'monday' AND title = 'Chairs & Tables'").get();
    assert.ok(section);

    await request(app)
      .post('/admin/setup/monday/tasks/add-item')
      .set('Cookie', cookie)
      .type('form')
      .send({ sectionId: String(section.id), description: 'Set up chairs', _csrf: csrfToken });
    await request(app)
      .post('/admin/setup/monday/tasks/add-item')
      .set('Cookie', cookie)
      .type('form')
      .send({ sectionId: String(section.id), description: 'Fold tables', _csrf: csrfToken });

    let items = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ? ORDER BY position').all(section.id);
    assert.deepEqual(items.map((i) => i.description), ['Set up chairs', 'Fold tables']);

    // Move the second item up - order should flip.
    await request(app)
      .post(`/admin/setup/monday/tasks/${section.id}/items/${items[1].id}/move`)
      .set('Cookie', cookie)
      .type('form')
      .send({ direction: 'up', _csrf: csrfToken });

    items = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ? ORDER BY position').all(section.id);
    assert.deepEqual(items.map((i) => i.description), ['Fold tables', 'Set up chairs']);
  });

  await t.test('the Save form updates a section title and an item description together', async () => {
    const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Old Title', 99)").run();
    const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Old task');

    await request(app)
      .post('/admin/setup/monday/tasks/save')
      .set('Cookie', cookie)
      .type('form')
      .send({
        [`sectionTitle_${section.lastInsertRowid}`]: 'New Title',
        [`itemDesc_${item.lastInsertRowid}`]: 'New task',
        _csrf: csrfToken,
      });

    assert.equal((await db.prepare('SELECT title FROM task_list_sections WHERE id = ?').get(section.lastInsertRowid)).title, 'New Title');
    assert.equal((await db.prepare('SELECT description FROM task_list_items WHERE id = ?').get(item.lastInsertRowid)).description, 'New task');
  });

  await t.test('deleting a section removes it (and its items, via cascade)', async () => {
    const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Temp List', 100)").run();
    await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Temp task');

    await request(app)
      .post(`/admin/setup/monday/tasks/${section.lastInsertRowid}/delete`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });

    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM task_list_sections WHERE id = ?').get(section.lastInsertRowid)).c), 0);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM task_list_items WHERE section_id = ?').get(section.lastInsertRowid)).c), 0);
  });

  await t.test('a Setup/Cleanup team card shows its own linked task list', async () => {
    const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Linked Team')").run();
    const section = await db.prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Team Tasks', ?, 0)").run(team.lastInsertRowid);
    await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Linked task');

    const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Linked Team/);
    assert.match(res.text, /Linked task/);
  });
});
