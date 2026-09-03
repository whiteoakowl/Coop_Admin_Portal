// Real HTTP-level coverage for the Member Profile page's Class Schedule
// and Attendance tabs (routes/admin-members.js's GET /members/:id):
//   - The Class Schedule tab's "Generated automatically..." hint text was
//     removed (not needed).
//   - Both tabs now offer a "Family Member" dropdown listing every member
//     of the same family (including the one currently being viewed, pre-
//     selected) so an admin can jump straight to another family member's
//     same tab instead of going back to the Members list - only shown
//     when there's actually another family member to jump to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-profile-family-select-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-profile-family-select-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('Member Profile Class Schedule tab', async (t) => {
  const cookie = await loginAsAdmin();

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Select Family')).lastInsertRowid;
  const parentId = (await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Select Family Parent', 'sel-fam-parent', 'parent', ?)")
    .run(familyId)).lastInsertRowid;
  const kidId = (await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Select Family Kid', 'sel-fam-kid', 'student', ?)")
    .run(familyId)).lastInsertRowid;
  const lonerId = (await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Family Member', 'no-fam-member', 'student')")
    .run()).lastInsertRowid;

  await t.test('the "Generated automatically" hint text is gone', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Generated automatically/);
  });

  // A real, later request: "a parent's own profile page shouldn't
  // require an extra click to see the whole family's schedule" - a
  // parent viewing their OWN Class Schedule tab now defaults straight to
  // the family-wide "All" view (routes/admin-members.js's own
  // familyAllDefault), so "All" is what's pre-selected in the dropdown
  // for a parent, not their own individual option - see the student case
  // just below for where the individually-pre-selected behavior this
  // dropdown was originally built for still applies.
  await t.test('a parent with others in the family gets a Family Member dropdown listing everyone, defaulting to "All"', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /id="schedule-family-member-select"/);
    assert.match(res.text, /<option value="all" selected>All<\/option>/);
    assert.match(res.text, new RegExp(`<option value="${parentId}" >Select Family Parent</option>`));
    assert.match(res.text, new RegExp(`<option value="${kidId}"[^>]*>Select Family Kid</option>`));
  });

  // Students don't get the "auto-default to All" treatment (same route
  // comment as above) - viewing a student's own tab still pre-selects
  // just themselves, the dropdown's original behavior.
  await t.test('a student with others in the family gets the dropdown pre-selected to themselves, not "All"', async () => {
    const res = await request(app).get(`/admin/members/${kidId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<option value="all" >All<\/option>/);
    assert.match(res.text, new RegExp(`<option value="${kidId}" selected>Select Family Kid</option>`));
    assert.match(res.text, new RegExp(`<option value="${parentId}"[^>]*>Select Family Parent</option>`));
  });

  await t.test('a member with no family at all gets no dropdown (nothing to jump to)', async () => {
    const res = await request(app).get(`/admin/members/${lonerId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /id="schedule-family-member-select"/);
  });

  await t.test('picking the other family member navigates to their own schedule tab', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=schedule`).set('Cookie', cookie);
    assert.match(res.text, /window\.location = '\/admin\/members\/' \+ this\.value \+ '\?tab=schedule'/);
  });
});

test('Member Profile Attendance tab gets the same Family Member dropdown', async (t) => {
  const cookie = await loginAsAdmin();

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Attendance Select Family')).lastInsertRowid;
  const parentId = (await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Attendance Family Parent', 'att-fam-parent', 'parent', ?)")
    .run(familyId)).lastInsertRowid;
  const kidId = (await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Attendance Family Kid', 'att-fam-kid', 'student', ?)")
    .run(familyId)).lastInsertRowid;

  // A parent auto-defaults to the family-wide "All" view here too (same
  // real request/behavior as the Class Schedule tab above), so "All" -
  // not the parent's own option - is what's pre-selected.
  await t.test('shows the dropdown, defaulting to "All" for a parent', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=attendance`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /id="attendance-family-member-select"/);
    assert.match(res.text, /window\.location = '\/admin\/members\/' \+ this\.value \+ '\?tab=attendance'/);
    assert.match(res.text, /<option value="all" selected>All<\/option>/);
    assert.match(res.text, new RegExp(`<option value="${parentId}" >Attendance Family Parent</option>`));
  });

  await t.test('a student still gets pre-selected to themselves, not "All"', async () => {
    const res = await request(app).get(`/admin/members/${kidId}?tab=attendance`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<option value="all" >All<\/option>/);
    assert.match(res.text, new RegExp(`<option value="${kidId}" selected>Attendance Family Kid</option>`));
  });
});
