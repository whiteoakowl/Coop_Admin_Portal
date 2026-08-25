// Coverage for the Floater Assignments "Add/Edit Position" dialog (a real
// request: "Add position button should say add/edit position. When you
// click it will show a list of the permanent positions added and stacked
// underneath the position it will say what hours have been selected with
// check boxes. Should be able to change name of positions, room number
// and check or uncheck boxes as necessary. Orange save button top right
// closes the window and applies the changes.") - utils/substitutes.js's
// groupedPermanentJobsForDay/savePositionGroup, and routes/admin-
// substitutes.js's single /permanent-jobs/save-groups POST that applies
// every position in the dialog at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-position-groups-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-position-groups-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('the manage page button reads "+ Add/Edit Position"', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.match(res.text, /\+ Add\/Edit Position/);
});

test('the dialog lists every existing position, stacked, with its own hours checked', async () => {
  const { cookie } = await loginAsAdmin();
  await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 1, 'Front Desk', '101')").run();
  await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 2, 'Front Desk', '101')").run();
  await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 3, 'Library Desk', '')").run();

  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const dialogMatch = /<dialog id="add-job-dialog"[\s\S]*?<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'expected the add-job-dialog to be present');
  const dialogHtml = dialogMatch[0];
  assert.match(dialogHtml, /value="Front Desk"/);
  assert.match(dialogHtml, /value="Library Desk"/);
  // Front Desk's own Hour 1/2 checkboxes should be checked, Hour 3/4 not.
  const frontDeskMatch = /groups\[\d+\]\[title\]" value="Front Desk"[\s\S]*?<\/div>\s*<\/div>/.exec(dialogHtml);
  assert.ok(frontDeskMatch);
  const frontDeskChecked = [...frontDeskMatch[0].matchAll(/value="(\d)" (checked)?/g)];
  const checkedHours = frontDeskChecked.filter((m) => m[2]).map((m) => m[1]);
  assert.deepEqual(checkedHours.sort(), ['1', '2']);
});

test('saving the dialog can edit an existing position\'s title/room, add a brand-new one, and remove another by unchecking every hour', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const frontDesk1 = (await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('wednesday', 1, 'Old Name', '9')").run()).lastInsertRowid;
  await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('wednesday', 2, 'Old Name', '9')").run();
  const goingAway = (await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('wednesday', 1, 'Going Away', '')").run()).lastInsertRowid;

  const member = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Floater One', 'floater-one', 'parent', NULL, 1)").run();
  await db.prepare('INSERT INTO permanent_job_floaters (job_id, member_id) VALUES (?, ?)').run(frontDesk1, member.lastInsertRowid);

  await request(app)
    .post('/admin/volunteers/wednesday/substitutes/permanent-jobs/save-groups')
    .set('Cookie', cookie)
    .type('form')
    .send({
      _csrf: csrfToken,
      date: '',
      groups: {
        [frontDesk1]: { title: 'New Name', room: '12', hours: ['1', '3'] },
        [goingAway]: { title: 'Going Away', room: '', hours: [] },
        new: { title: 'Brand New Desk', room: '5', hours: ['4'] },
      },
    });

  const jobs = await db.prepare("SELECT * FROM permanent_jobs WHERE day = 'wednesday' ORDER BY title, hour_position").all();
  const byTitle = {};
  jobs.forEach((j) => { (byTitle[j.title] = byTitle[j.title] || []).push(j); });

  assert.ok(!byTitle['Old Name'], 'the old title should be gone entirely, renamed everywhere');
  assert.ok(!byTitle['Going Away'], 'unchecking every hour should remove the position entirely');
  assert.equal(byTitle['New Name'].length, 2, 'hour 3 should have been added alongside the renamed hour 1 row; hour 2 dropped since it was unchecked');
  assert.deepEqual(byTitle['New Name'].map((j) => j.hour_position).sort(), [1, 3]);
  byTitle['New Name'].forEach((j) => assert.equal(j.room, '12'));
  assert.equal(byTitle['Brand New Desk'].length, 1);
  assert.equal(byTitle['Brand New Desk'][0].hour_position, 4);
  assert.equal(byTitle['Brand New Desk'][0].room, '5');

  // The hour-1 row that stayed checked keeps its own id (updated in
  // place, not deleted+recreated) - its floater assignment survives.
  const stillHour1 = byTitle['New Name'].find((j) => j.hour_position === 1);
  assert.equal(stillHour1.id, frontDesk1, 'the surviving hour should be the SAME row, not a new one');
  const floaters = await db.prepare('SELECT member_id FROM permanent_job_floaters WHERE job_id = ?').all(frontDesk1);
  assert.deepEqual(floaters.map((f) => f.member_id), [member.lastInsertRowid], 'renaming a still-checked hour must not wipe its floater list');
});

// A real request: "next to each position in that pop up there should be
// a trashcan symbol to remove that position. once you click the trash
// can the position is deleted but the add/edit window remains open for
// editing."
test('each existing position in the dialog has its own trash-icon delete button', async () => {
  const { cookie } = await loginAsAdmin();
  const jobId = (await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 1, 'Copy Room', '2')").run()).lastInsertRowid;

  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const dialogHtml = /<dialog id="add-job-dialog"[\s\S]*?<\/dialog>/.exec(res.text)[0];
  assert.match(
    dialogHtml,
    new RegExp(`formaction="/admin/volunteers/monday/substitutes/permanent-jobs/group/${jobId}/delete\\?dialog=job"`),
    'the Copy Room group should have its own delete button targeting its keyId'
  );
  // The blank "Add New Position" row at the bottom has nothing to delete.
  assert.doesNotMatch(dialogHtml.slice(dialogHtml.indexOf('Add New Position')), /icon-btn-danger/);
});

test('clicking a position\'s trash icon deletes every hour row for that position, keeps the dialog open, and leaves other positions alone', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const goneHour1 = (await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 1, 'Kitchen Duty', '')").run()).lastInsertRowid;
  await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 2, 'Kitchen Duty', '')").run();
  const staysId = (await db.prepare("INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES ('monday', 1, 'Front Desk', '')").run()).lastInsertRowid;
  const floater = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Kitchen Floater', 'kitchen-floater-1', 'parent')").run();
  await db
    .prepare(`INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status) VALUES ('2026-09-14', 'job', ?, ?, 0, 'approved')`)
    .run(goneHour1, floater.lastInsertRowid);

  const res = await request(app)
    .post(`/admin/volunteers/monday/substitutes/permanent-jobs/group/${goneHour1}/delete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, date: '2026-09-14' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /dialog=job/, 'the redirect should keep the dialog open, not drop back to the closed manage page');

  const remainingKitchen = await db.prepare("SELECT * FROM permanent_jobs WHERE day = 'monday' AND title = 'Kitchen Duty'").all();
  assert.equal(remainingKitchen.length, 0, 'both of Kitchen Duty\'s hour rows should be gone, not just the one keyId pointed at');
  const remainingAssignments = await db.prepare("SELECT * FROM substitute_assignments WHERE slot_type = 'job' AND slot_id = ?").all(goneHour1);
  assert.equal(remainingAssignments.length, 0, 'the deleted position\'s own substitute assignment should be cleaned up too');

  const stillThere = await db.prepare('SELECT * FROM permanent_jobs WHERE id = ?').get(staysId);
  assert.ok(stillThere, 'Front Desk, a completely different position, must be untouched');

  // The manage page's own reopen script should target the real dialog id
  // (add-job-dialog), not a guessed edit-job-dialog that doesn't exist -
  // a real bug this session found while wiring this same redirect.
  const afterRedirect = await request(app).get(res.headers.location).set('Cookie', cookie);
  assert.match(afterRedirect.text, /document\.getElementById\('add-job-dialog'\)\.showModal\(\)/);
});
