// Coverage for POST /name-tag/submit (routes/name-tag.js), added while
// converting it to async/await as part of the Supabase migration (see
// MIGRATION.md) - it had no test coverage before this. Runs against the
// still-live SQLite backend (await on a non-Promise value is a
// transparent pass-through), so this suite doubles as proof the
// conversion didn't change behavior - specifically, that awaiting each
// insert.run() call inside the for-of loop (unchanged loop shape, just
// now awaited) still inserts one row per selected member.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-submit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-submit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('POST /name-tag/submit', async (t) => {
  const { lastInsertRowid: parentId } = db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Robin Parent', 'Robin Parent', 'parent')")
    .run();
  const { lastInsertRowid: familyId } = db.prepare('INSERT INTO families (name) VALUES (?)').run('Parent Family');
  db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, parentId);
  const { lastInsertRowid: childId } = db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Robin Kid', 'Robin Kid', 'student', ?)")
    .run(familyId);

  await t.test('a valid submission inserts one request per selected member', async () => {
    const res = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({
        parentId: String(parentId),
        memberIds: [String(parentId), String(childId)],
        requestType: 'lost_tag',
        day: 'monday',
        description: 'testing',
      });
    assert.equal(res.status, 200);
    assert.match(res.text, /Request submitted for/);

    const rows = db.prepare('SELECT member_id FROM name_tag_requests ORDER BY member_id').all();
    assert.deepEqual(
      rows.map((r) => r.member_id).sort((a, b) => a - b),
      [parentId, childId].sort((a, b) => a - b)
    );
  });

  await t.test('a member outside the submitting parent\'s family is rejected, nothing inserted', async () => {
    const { lastInsertRowid: strangerId } = db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Stranger Kid', 'Stranger Kid', 'student')")
      .run();
    const before = db.prepare('SELECT COUNT(*) AS c FROM name_tag_requests').get().c;

    const res = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({ parentId: String(parentId), memberIds: [String(strangerId)], requestType: 'lost_tag', day: 'monday' });
    assert.equal(res.status, 200);
    assert.match(res.text, /Please select at least one name/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM name_tag_requests').get().c, before);
  });
});
