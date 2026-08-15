// Real HTTP-level coverage for the Members page's family filter
// (routes/admin-members.js's GET /members?family=<id>, added to the
// existing "Filter by type" dropdown as a Family optgroup rather than a
// separate control) - utils/members.js's membersWithDetails() gained an
// optional familyId argument to power it.
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

  await t.test('the type-select dropdown lists every family as an option', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`<option value="/admin/members\\?family=${familyA}"[^>]*>Filter Family A</option>`));
    assert.match(res.text, new RegExp(`<option value="/admin/members\\?family=${familyB}"[^>]*>Filter Family B</option>`));
  });

  await t.test('?family=<id> shows only that family\'s members', async () => {
    const res = await request(app).get(`/admin/members?family=${familyA}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Member In A/);
    assert.doesNotMatch(res.text, /Member In B/);
    assert.doesNotMatch(res.text, /No Family Member/);
  });

  await t.test('the selected family option is marked selected', async () => {
    const res = await request(app).get(`/admin/members?family=${familyA}`).set('Cookie', cookie);
    assert.match(res.text, new RegExp(`<option value="/admin/members\\?family=${familyA}" selected>Filter Family A</option>`));
  });

  await t.test('export.csv also honors ?family=<id>', async () => {
    const res = await request(app).get(`/admin/members/export.csv?family=${familyA}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Member In A/);
    assert.doesNotMatch(res.text, /Member In B/);
  });
});
