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
