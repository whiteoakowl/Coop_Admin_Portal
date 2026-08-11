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
const { execFileSync } = require('child_process');

const { DEFAULT_LAYOUTS, FIELDS_BY_TYPE } = require('../utils/nameTagBadge');

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

test('badgeDataForMember formats memberCode as "ID#123456" for both parents and students', async (t) => {
  const testDbPath = path.join(os.tmpdir(), `name-tag-member-code-test-db-${process.pid}.db`);
  process.env.DB_PATH = testDbPath;
  const db = require('../db');
  const { badgeDataForMember } = require('../utils/nameTagData');

  t.after(() => {
    fs.rmSync(testDbPath, { force: true });
    fs.rmSync(`${testDbPath}-wal`, { force: true });
    fs.rmSync(`${testDbPath}-shm`, { force: true });
  });

  const parentId = db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Test Parent', '000111', '000111', 'parent')")
    .run().lastInsertRowid;
  const studentId = db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Test Student', '000222', '000222', 'student')")
    .run().lastInsertRowid;

  const parent = db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const student = db.prepare('SELECT * FROM members WHERE id = ?').get(studentId);

  assert.equal((await badgeDataForMember(parent)).memberCode, 'ID#000111');
  assert.equal((await badgeDataForMember(student)).memberCode, 'ID#000222');
});

// Subprocess boot, same pattern as test/memberCodeMigration.test.js - a
// saved name_tag_templates row (the shape the design editor actually
// persists) with the old untouched "org" box gets migrated forward on the
// next boot; a row that's already been customized past that fingerprint is
// left alone.
test('db/index.js migrates a saved name tag template still on the old "Sanford Homeschoolers" default', async (t) => {
  const testDbPath = path.join(os.tmpdir(), `name-tag-template-migration-test-db-${process.pid}.db`);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-tag-template-migration-test-'));
  const dbModulePath = path.join(__dirname, '..', 'db');

  t.after(() => {
    fs.rmSync(testDbPath, { force: true });
    fs.rmSync(`${testDbPath}-wal`, { force: true });
    fs.rmSync(`${testDbPath}-shm`, { force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function writeScript(name, contents) {
    const filePath = path.join(scratchDir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }
  function run(scriptPath) {
    return execFileSync(process.execPath, [scriptPath], { env: { ...process.env, DB_PATH: testDbPath }, stdio: 'pipe' }).toString();
  }

  // Step 1: boot fresh - gets the current (already-migrated) default.
  run(writeScript('boot-fresh.js', `require(${JSON.stringify(dbModulePath)});`));

  // Step 2: overwrite the student template with the *old* saved shape -
  // an "org"/"Sanford Homeschoolers" custom-text box, as a real saved
  // template from before this change would have had it - and leave the
  // parent template with a org box the admin has since edited (different
  // text), which must NOT be touched.
  run(
    writeScript(
      'seed-old-templates.js',
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.env.DB_PATH);
      const oldStudentLayout = JSON.stringify({
        background: '#ffffff',
        backgroundOpacity: 1,
        elements: [
          { id: 'org', type: 'text', field: 'custom', text: 'Sanford Homeschoolers', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
          { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
        ],
      });
      const customizedParentLayout = JSON.stringify({
        background: '#ffffff',
        backgroundOpacity: 1,
        elements: [
          { id: 'org', type: 'text', field: 'custom', text: 'Welcome, Volunteers!', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
          { id: 'name', type: 'text', field: 'name', x: 8, y: 28, width: 320, height: 30, fontSize: 19, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
        ],
      });
      db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'student'").run(oldStudentLayout);
      db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(customizedParentLayout);
      db.close();
      `
    )
  );

  // Step 3: reboot - this is where the migration runs.
  run(writeScript('boot-again.js', `require(${JSON.stringify(dbModulePath)});`));

  // Step 4: verify.
  const output = run(
    writeScript(
      'verify.js',
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.env.DB_PATH);
      const rows = db.prepare("SELECT member_type, layout_json FROM name_tag_templates WHERE member_type IN ('student', 'parent')").all();
      process.stdout.write(JSON.stringify(rows));
      db.close();
      `
    )
  );
  const rows = JSON.parse(output);
  const student = JSON.parse(rows.find((r) => r.member_type === 'student').layout_json);
  const parent = JSON.parse(rows.find((r) => r.member_type === 'parent').layout_json);

  const studentOrgEl = student.elements.find((el) => el.id === 'org');
  assert.equal(studentOrgEl.field, 'memberCode', "the untouched student org box should be migrated to the memberCode field");
  assert.equal(studentOrgEl.text, undefined, 'the old literal text should be gone');

  const parentOrgEl = parent.elements.find((el) => el.id === 'org');
  assert.equal(parentOrgEl.field, 'custom', "an admin-customized org box (different text) must be left alone");
  assert.equal(parentOrgEl.text, 'Welcome, Volunteers!');
});
