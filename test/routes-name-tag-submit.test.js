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

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('POST /name-tag/submit', async (t) => {
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Robin Parent', 'Robin Parent', 'parent')")
    .run();
  const { lastInsertRowid: familyId } = await db.prepare('INSERT INTO families (name) VALUES (?)').run('Parent Family');
  await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, parentId);
  const { lastInsertRowid: childId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Robin Kid', 'Robin Kid', 'student', ?)")
    .run(familyId);

  await t.test('a valid submission inserts one request per selected member', async () => {
    const res = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({
        memberId: String(parentId),
        memberIds: [String(parentId), String(childId)],
        requestType: 'lost_tag',
        day: 'monday',
        description: 'testing',
      });
    assert.equal(res.status, 200);
    assert.match(res.text, /Request submitted for/);

    const rows = await db.prepare('SELECT member_id FROM name_tag_requests ORDER BY member_id').all();
    assert.deepEqual(
      rows.map((r) => r.member_id).sort((a, b) => a - b),
      [parentId, childId].sort((a, b) => a - b)
    );
  });

  await t.test('a member outside the submitting parent\'s family is rejected, nothing inserted', async () => {
    const { lastInsertRowid: strangerId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Stranger Kid', 'Stranger Kid', 'student')")
      .run();
    const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM name_tag_requests').get()).c);

    const res = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({ memberId: String(parentId), memberIds: [String(strangerId)], requestType: 'lost_tag', day: 'monday' });
    assert.equal(res.status, 200);
    assert.match(res.text, /Please select at least one name/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM name_tag_requests').get()).c), before);
  });

  // A real request: "the drop down menu of names should include all
  // members admin, primary parent, parent and student" - a student old
  // enough to fill this out themselves shouldn't need a parent to do it
  // for them, unlike Absence/Late's still-parent+admin-only picker.
  await t.test('a student can pick themselves as the requester and submit for themselves', async () => {
    const res = await request(app)
      .get('/name-tag');
    assert.equal(res.status, 200);
    assert.match(res.text, /Robin Kid/, 'the student should appear in the "Select your name" dropdown, not just as a child under a parent');

    const submit = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({ memberId: String(childId), memberIds: [String(childId)], requestType: 'schedule_change', day: 'wednesday' });
    assert.equal(submit.status, 200);
    assert.match(submit.text, /Request submitted for Robin Kid/);
  });

  await t.test('an admin also appears in the picker and can submit for themselves', async () => {
    const { lastInsertRowid: adminId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Alex Admin', 'Alex Admin', 'admin')")
      .run();

    const res = await request(app).get('/name-tag');
    assert.match(res.text, /Alex Admin/);

    const submit = await request(app)
      .post('/name-tag/submit')
      .type('form')
      .send({ memberId: String(adminId), memberIds: [String(adminId)], requestType: 'lost_tag', day: 'both' });
    assert.equal(submit.status, 200);
    assert.match(submit.text, /Request submitted for Alex Admin/);
  });
});

test('GET /name-tag lists every active member type in the picker, correctly labeled', async (t) => {
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Label Admin', 'Label Admin', 'admin')").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Label Parent', 'Label Parent', 'parent')").run();
  const { lastInsertRowid: studentId2 } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Label Student', 'Label Student', 'student')")
    .run();

  await t.test('admins, parents, and students all appear in the dropdown with their real type', async () => {
    const res = await request(app).get('/name-tag');
    assert.equal(res.status, 200);
    assert.match(res.text, /Label Admin \(Admin\)/);
    assert.match(res.text, /Label Parent \(Parent\)/);
    assert.match(res.text, /Label Student \(Student\)/);
  });

  await t.test('a student picked as the submitter shows their own checkbox group with their real type', async () => {
    const res = await request(app).get('/name-tag');
    // Every member's own self-checkbox is rendered (all groups render,
    // only the matching one is unhidden client-side) - the student's own
    // group should show their real type, not a hardcoded "(Parent)".
    const groupStart = res.text.indexOf(`data-member-id="${studentId2}"`);
    assert.ok(groupStart !== -1, 'expected a member group for the student');
    const groupHtml = res.text.slice(groupStart, groupStart + 500);
    assert.match(groupHtml, /Label Student \(Student\)/);
  });
});
