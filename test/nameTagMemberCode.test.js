// Real coverage for swapping the name tag's old "Sanford Homeschoolers"
// title box for a Member ID box (utils/nameTagBadge.js's DEFAULT_LAYOUTS,
// utils/nameTagData.js's badgeDataForMember) - see db/index.js's own
// migration comment for why a *saved* template needs the same swap on
// boot, not just the fresh-install default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-member-code-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const { DEFAULT_LAYOUTS, FIELDS_BY_TYPE } = require('../utils/nameTagBadge');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
});

test('DEFAULT_LAYOUTS.student/parent no longer have a literal "Sanford Homeschoolers" box, and expose a memberCode field', () => {
  for (const type of ['student', 'parent']) {
    const elements = DEFAULT_LAYOUTS[type].elements;
    assert.ok(!elements.some((el) => el.text === 'Sanford Homeschoolers'), `${type} default should have no hardcoded org text left`);
    const memberCodeEl = elements.find((el) => el.type === 'text' && el.field === 'memberCode');
    assert.ok(memberCodeEl, `${type} default should have a text element bound to memberCode`);
    assert.ok(
      FIELDS_BY_TYPE[type].some((f) => f.field === 'memberCode'),
      `${type}'s field picker should offer Member ID`
    );
  }
});

test('badgeDataForMember formats memberCode as "ID#123456" for both parents and students', async () => {
  const db = require('../db');
  const { badgeDataForMember } = require('../utils/nameTagData');
  await db.ready;

  const parentId = (await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Test Parent', '000111', '000111', 'parent')")
    .run()).lastInsertRowid;
  const studentId = (await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Test Student', '000222', '000222', 'student')")
    .run()).lastInsertRowid;

  const parent = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const student = await db.prepare('SELECT * FROM members WHERE id = ?').get(studentId);

  assert.equal((await badgeDataForMember(parent)).memberCode, 'ID#000111');
  assert.equal((await badgeDataForMember(student)).memberCode, 'ID#000222');
});

// The saved-template migration this file used to also cover
// ("db/index.js migrates a saved name tag template still on the old
// Sanford Homeschoolers default") tested a one-time SQLite upgrade path
// for an already-deployed database predating this feature - retired along
// with the rest of db/index.js's upgrade blocks now that a fresh
// install always starts from the current schema (see db/bootstrapPg.js's
// own header comment). Nothing to migrate on a brand-new Postgres
// database, so nothing to test here anymore.
