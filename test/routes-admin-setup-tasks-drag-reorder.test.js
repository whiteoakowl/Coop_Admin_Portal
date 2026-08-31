// Coverage for the Setup/Cleanup Task List's new drag-and-drop reorder
// endpoints (a real request: "be able to rearrange the setup/cleanup
// task list on desktop and mobile. drag and move.") - POST
// /admin/setup/:day/tasks/reorder (whole list stack) and POST
// /admin/setup/:day/tasks/:sectionId/items/reorder (one section's own
// tasks), both driven by public/js/task-list-drag-reorder.js sending the
// final on-screen order as JSON after a drag. These sit ALONGSIDE the
// existing up/down /move routes (still covered by
// test/routes-admin-setup-tasks.test.js), not replacing them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-tasks-drag-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-tasks-drag-test-uploads-${process.pid}`);
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

test('Setup/Cleanup Task List drag-and-drop reorder', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('dragging a section to a new position persists via /tasks/reorder', async () => {
    const a = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Drag Section A', 0)").run();
    const b = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Drag Section B', 1)").run();
    const c = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Drag Section C', 2)").run();

    // Drag C to the front: new order is C, A, B.
    const res = await request(app)
      .post('/admin/setup/monday/tasks/reorder')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ sectionIds: [c.lastInsertRowid, a.lastInsertRowid, b.lastInsertRowid] });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const sections = await db.prepare("SELECT id, title FROM task_list_sections WHERE day = 'monday' ORDER BY position").all();
    const dragged = sections.filter((s) => ['Drag Section A', 'Drag Section B', 'Drag Section C'].includes(s.title));
    assert.deepEqual(dragged.map((s) => s.title), ['Drag Section C', 'Drag Section A', 'Drag Section B']);
  });

  await t.test('a section id from a DIFFERENT day is ignored, not moved into this day\'s ordering', async () => {
    const wed = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('wednesday', 'Wed Section', 0)").run();
    const mon = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Mon Only Section', 50)").run();

    await request(app)
      .post('/admin/setup/monday/tasks/reorder')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ sectionIds: [wed.lastInsertRowid, mon.lastInsertRowid] });

    const wedSection = await db.prepare('SELECT day, position FROM task_list_sections WHERE id = ?').get(wed.lastInsertRowid);
    assert.equal(wedSection.day, 'wednesday', "the Wednesday section's day must not change");
    assert.equal(wedSection.position, 0, "the Wednesday section's own position must be untouched");
  });

  await t.test('dragging a task to a new position persists via items/reorder, and the # numbering follows', async () => {
    const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Drag Items Section', 99)").run();
    const item1 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'First task');
    const item2 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)').run(section.lastInsertRowid, 'Second task');
    const item3 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 2)').run(section.lastInsertRowid, 'Third task');

    // Drag the third task to the front.
    const res = await request(app)
      .post(`/admin/setup/monday/tasks/${section.lastInsertRowid}/items/reorder`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ itemIds: [item3.lastInsertRowid, item1.lastInsertRowid, item2.lastInsertRowid] });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const items = await db.prepare('SELECT description FROM task_list_items WHERE section_id = ? ORDER BY position').all(section.lastInsertRowid);
    assert.deepEqual(items.map((i) => i.description), ['Third task', 'First task', 'Second task']);

    const page = await request(app).get('/admin/setup/monday/tasks').set('Cookie', cookie);
    assert.match(page.text, /Third task/);
    const rowRe = /<td class="task-list-num-col">(\d)<\/td>\s*<td><input type="text" name="itemDesc_\d+" value="Third task"/;
    const m = rowRe.exec(page.text);
    assert.ok(m, 'Third task row should exist with a # cell right before it');
    assert.equal(m[1], '1', "Third task's # should now be 1 after the drag");
  });

  await t.test('an item id from a DIFFERENT section is ignored', async () => {
    const sectionA = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Section A Items', 100)").run();
    const sectionB = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Section B Items', 101)").run();
    const itemInB = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(sectionB.lastInsertRowid, 'Belongs to B');
    const itemInA = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(sectionA.lastInsertRowid, 'Belongs to A');

    await request(app)
      .post(`/admin/setup/monday/tasks/${sectionA.lastInsertRowid}/items/reorder`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ itemIds: [itemInB.lastInsertRowid, itemInA.lastInsertRowid] });

    const stillInB = await db.prepare('SELECT section_id, position FROM task_list_items WHERE id = ?').get(itemInB.lastInsertRowid);
    assert.equal(stillInB.section_id, sectionB.lastInsertRowid, "the other section's item must not move sections");
    assert.equal(stillInB.position, 0, "the other section's item position must be untouched");
  });
});
