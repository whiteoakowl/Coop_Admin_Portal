// Real HTTP-level coverage for the Members list's family-collapse markup
// (public/js/members-family-collapse.js groups rows by this attribute and
// hides every member but the head-of-family one) - the actual show/hide
// toggle behavior is pure client-side JS this suite has no browser to
// exercise, but the server-rendered data-family-key attribute it depends
// on is real, testable HTML output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `members-family-collapse-markup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `members-family-collapse-markup-test-uploads-${process.pid}`);
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

test('Members list: same-family rows share a data-family-key, solo members get a unique one', async () => {
  const cookie = await loginAsAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Markup Test Family')").run()).lastInsertRowid;
  const primaryId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Markup Primary Parent', 'markup-primary', 'parent', ?, 1)")
      .run(familyId)
  ).lastInsertRowid;
  const kidId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Markup Kid', 'markup-kid', 'student', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const soloId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Markup Solo Member', 'markup-solo', 'parent')").run()
  ).lastInsertRowid;

  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  function keyFor(memberId) {
    const re = new RegExp(`<tr class="[^"]*" data-family-key="([^"]+)">[\\s\\S]*?</tr>`, 'g');
    let match;
    while ((match = re.exec(res.text))) {
      if (match[0].includes(`/admin/members/${memberId}"`)) return match[1];
    }
    return null;
  }

  const primaryKey = keyFor(primaryId);
  const kidKey = keyFor(kidId);
  const soloKey = keyFor(soloId);

  assert.ok(primaryKey, 'expected to find the primary parent row');
  assert.ok(kidKey, 'expected to find the kid row');
  assert.ok(soloKey, 'expected to find the solo member row');

  assert.equal(primaryKey, kidKey, 'members of the same family must share the same data-family-key so the client JS groups them together');
  assert.notEqual(soloKey, primaryKey, 'a member with no family must get its own unique data-family-key, never grouped with anyone else');
  assert.equal(primaryKey, `f${familyId}`);
  assert.equal(soloKey, `solo${soloId}`);
});
