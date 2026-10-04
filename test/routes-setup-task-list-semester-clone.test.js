// A real request: "Setup/cleanup task list should copy over to all new
// semesters created. If the task list is edited or added to on a
// specific semester it will not change the task list on another
// semester." Covers: creating a new semester seeds its own Task List
// from whichever semester most recently existed (sections + items, with
// their own fresh barcodes - never the same physical barcode reused
// across two semesters), and that editing the new semester's copy
// afterward never touches the original semester's own rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-task-list-semester-clone-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-task-list-semester-clone-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createSection, addItem, itemsForSection } = require('../utils/taskList');

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('creating a new semester copies the most recent semester\'s own Setup/Cleanup Task List, with fresh barcodes', async () => {
  const admin = await loginAsAdmin();

  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Fall 2026', _csrf: admin.csrfToken });
  const fall = await db.prepare("SELECT * FROM semesters WHERE title = 'Fall 2026'").get();

  const sectionId = await createSection('monday', 'Snack Table Team', null, fall.id);
  const itemId = await addItem(sectionId, 'Wipe down tables');
  const originalItem = (await itemsForSection(sectionId))[0];

  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Spring 2027', _csrf: admin.csrfToken });
  const spring = await db.prepare("SELECT * FROM semesters WHERE title = 'Spring 2027'").get();

  const clonedSection = await db.prepare('SELECT * FROM task_list_sections WHERE semester_id = ? AND day = ?').get(spring.id, 'monday');
  assert.ok(clonedSection, 'the new semester should have its own copy of the section');
  assert.equal(clonedSection.title, 'Snack Table Team');
  assert.equal(clonedSection.team_id, null, 'team_id is not copied - a new semester has no teams of its own yet');

  const clonedItems = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ?').all(clonedSection.id);
  assert.equal(clonedItems.length, 1);
  assert.equal(clonedItems[0].description, 'Wipe down tables');
  assert.notEqual(clonedItems[0].barcode, originalItem.barcode, 'the cloned item must get its own fresh barcode, never reusing the original');
  assert.notEqual(clonedItems[0].id, itemId);

  // Editing the NEW semester's copy must never touch the original.
  await db.prepare('UPDATE task_list_items SET description = ? WHERE id = ?').run('Changed only on Spring 2027', clonedItems[0].id);
  const originalStillIntact = await db.prepare('SELECT description FROM task_list_items WHERE id = ?').get(itemId);
  assert.equal(originalStillIntact.description, 'Wipe down tables', 'the original semester\'s own item must be unaffected by editing the clone');
});

test('a semester with no Task List sections of its own clones as empty too (no crash) - cloning always comes from the immediately-previous semester, not an earlier one', async () => {
  const admin = await loginAsAdmin();

  // Spring 2027 (from the test above) already has a cloned section.
  // Adding a semester right after it with nothing new added to its OWN
  // Task List should itself clone as empty for the NEXT semester after
  // IT - proving the clone source is always the immediate predecessor,
  // not "whichever semester most recently had a non-empty list."
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Untouched Semester', _csrf: admin.csrfToken });
  const untouched = await db.prepare("SELECT * FROM semesters WHERE title = 'Untouched Semester'").get();
  const untouchedSections = await db.prepare('SELECT * FROM task_list_sections WHERE semester_id = ?').all(untouched.id);
  assert.ok(untouchedSections.length > 0, 'Untouched Semester itself should have cloned a copy from Spring 2027');

  // Now delete every one of Untouched Semester's own cloned sections,
  // simulating a semester an admin cleared out on purpose.
  await db.prepare('DELETE FROM task_list_sections WHERE semester_id = ?').run(untouched.id);

  const res = await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Next After Cleared', _csrf: admin.csrfToken });
  assert.match(res.headers.location, /notice=/, 'creating a semester right after an empty-Task-List one should not error');
  const nextSemester = await db.prepare("SELECT * FROM semesters WHERE title = 'Next After Cleared'").get();
  const nextSections = await db.prepare('SELECT * FROM task_list_sections WHERE semester_id = ?').all(nextSemester.id);
  assert.equal(nextSections.length, 0, 'cloning from an immediate predecessor with an empty Task List should leave the new one empty too, not reach further back');
});
