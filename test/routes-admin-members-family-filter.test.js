// Real HTTP-level coverage for the Members page's family filter
// (routes/admin-members.js's GET /members?family=<id>) - utils/
// members.js's membersWithDetails() gained an optional familyId argument
// to power it. The family picker itself now lives in the Filter dialog's
// own <select name="family"> (a later real request: "filter button and
// search bar on co-op admin portal members should be the same as main
// admin portal members" moved it off the old per-option-URL dropdown).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-family-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-family-filter-test-uploads-${process.pid}`);
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

test('Members page family filter', async (t) => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  const familyA = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Filter Family A')).lastInsertRowid;
  const familyB = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Filter Family B')).lastInsertRowid;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Member In A', 'member-in-a', 'parent', ?)").run(familyA);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Member In B', 'member-in-b', 'parent', ?)").run(familyB);
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Family Member', 'no-family-member', 'parent')").run();
  // Co-op Admin's own Members list only shows families with an enrolled
  // student (real request: "members only appear on the member list for
  // co-op admin portal if they are registered for classes"), so Family A
  // needs a registered student of its own for "Member In A" to show here.
  const kidInAId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Kid In A', 'kid-in-a', 'student', ?) RETURNING id").get(familyA)
  ).id;
  const fixtureClassId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Family Filter Fixture Class') RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(fixtureClassId, kidInAId);

  await t.test('the Filter dialog\'s Family select lists every family as an option', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`<option value="${familyA}"[^>]*>Filter Family A Family</option>`));
    assert.match(res.text, new RegExp(`<option value="${familyB}"[^>]*>Filter Family B Family</option>`));
  });

  await t.test('?family=<id> shows only that family\'s members', async () => {
    const res = await request(app).get(`/admin/members?family=${familyA}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Member In A/);
    assert.doesNotMatch(res.text, /Member In B/);
    assert.doesNotMatch(res.text, /No Family Member/);
  });

  await t.test('the selected family option is marked selected, and the Filter button label shows it', async () => {
    const res = await request(app).get(`/admin/members?family=${familyA}`).set('Cookie', cookie);
    assert.match(res.text, new RegExp(`<option value="${familyA}" selected>Filter Family A Family</option>`));
    assert.match(res.text, /Filter: Filter Family A Family/);
  });

  await t.test('export.csv also honors ?family=<id>', async () => {
    const res = await request(app).get(`/admin/members/export.csv?family=${familyA}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Member In A/);
    assert.doesNotMatch(res.text, /Member In B/);
  });
});
