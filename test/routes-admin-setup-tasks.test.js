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
const XLSX = require('xlsx');

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([['Number', 'Day', 'List', 'Task'], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

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

test('Setup/Cleanup Task List import - Number, Day, List, Task columns', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('GET import-template.xlsx has the Number, Day, List, Task headers', async () => {
    const res = await request(app)
      .get('/admin/setup/monday/tasks/import-template.xlsx')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.deepEqual(rows[0], ['Number', 'Day', 'List', 'Task']);
  });

  await t.test('rows land in Number order within their list, regardless of file order, and a new list is created on demand', async () => {
    const buffer = buildImportBuffer([
      ['2', 'Monday', 'Import Kitchen', 'Wipe counters'],
      ['1', 'Monday', 'Import Kitchen', 'Sweep floor'],
    ]);
    const res = await request(app)
      .post('/admin/setup/monday/tasks/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'tasks.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 task'));

    const section = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'monday' AND title = 'Import Kitchen'").get();
    assert.ok(section, 'a new list should be created for a List value that did not exist yet');
    const items = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ? ORDER BY position').all(section.id);
    assert.deepEqual(items.map((i) => i.description), ['Sweep floor', 'Wipe counters'], 'Number 1 should land before Number 2 regardless of row order in the file');
  });

  await t.test('one file can import both Monday and Wednesday rows at once via the Day column', async () => {
    const buffer = buildImportBuffer([
      ['1', 'Monday', 'Cross Day List', 'Monday task'],
      ['1', 'Wed', 'Cross Day List', 'Wednesday task'],
    ]);
    const res = await request(app)
      .post('/admin/setup/monday/tasks/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'cross-day.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 task'));

    const mondaySection = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'monday' AND title = 'Cross Day List'").get();
    const wedSection = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'wednesday' AND title = 'Cross Day List'").get();
    assert.ok(mondaySection && wedSection, '"Wed" should resolve to wednesday, landing in its own separate list even though the file was uploaded from the Monday tab');
    assert.equal((await db.prepare('SELECT description FROM task_list_items WHERE section_id = ?').get(mondaySection.id)).description, 'Monday task');
    assert.equal((await db.prepare('SELECT description FROM task_list_items WHERE section_id = ?').get(wedSection.id)).description, 'Wednesday task');
  });

  await t.test('a row with a blank Day falls back to whichever day tab Import was clicked from', async () => {
    const buffer = buildImportBuffer([['1', '', 'Fallback Day List', 'No day given']]);
    const res = await request(app)
      .post('/admin/setup/wednesday/tasks/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'fallback.xlsx');
    assert.equal(res.status, 302);

    const section = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'wednesday' AND title = 'Fallback Day List'").get();
    assert.ok(section, 'a blank Day should fall back to the wednesday tab the import was submitted from');
  });

  await t.test('a row missing List or Task is skipped, not fatal to the others', async () => {
    const buffer = buildImportBuffer([
      ['1', 'Monday', '', 'No list given'],
      ['1', 'Monday', 'Valid Skip List', ''],
      ['1', 'Monday', 'Valid Skip List', 'This one is fine'],
    ]);
    const res = await request(app)
      .post('/admin/setup/monday/tasks/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'skip.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 1 task'));

    const section = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'monday' AND title = 'Valid Skip List'").get();
    const items = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ?').all(section.id);
    assert.equal(items.length, 1);
  });
});

test('a Delete Task trash button is always visible per task row, not hidden behind Edit mode', async () => {
  const { cookie } = await loginAsAdmin();
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Always Visible Trash List', 200)").run();
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Always visible trash task');

  const res = await request(app).get('/admin/setup/monday/tasks').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const deleteAction = `/admin/setup/monday/tasks/${section.lastInsertRowid}/items/${item.lastInsertRowid}/delete`;
  const deleteFormIndex = res.text.indexOf(deleteAction);
  assert.ok(deleteFormIndex !== -1, 'the delete form should be present');
  // The delete button's own <td> should not carry data-task-list-edit-only
  // (which starts hidden until "Edit" is clicked) - look at the nearest
  // preceding <td class= to confirm it's the always-visible actions-cell
  // one, not the reorder buttons' edit-gated cell.
  const precedingTd = res.text.lastIndexOf('<td class=', deleteFormIndex);
  const tdTag = res.text.slice(precedingTd, res.text.indexOf('>', precedingTd) + 1);
  assert.match(tdTag, /actions-cell/);
  assert.doesNotMatch(tdTag, /data-task-list-edit-only/);
});
