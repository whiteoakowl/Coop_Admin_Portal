// Real coverage for a design tweak this session: the Schedule Card's
// default layout no longer shows the member's own name (redundant - the
// card is already handed to that specific member) and instead shows their
// Allergy top-left in red, matching how the Name Tag's own Allergies
// field is styled; the Name Tag's default layout, in turn, no longer
// shows Allergies at all (utils/nameTagBadge.js, utils/scheduleCardBadge.js,
// utils/scheduleCardData.js). Both fields stay available in each editor's
// field picker (FIELDS/FIELDS_BY_TYPE) even though they're not on the
// default layout, so an admin can still add either back by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-card-allergy-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const { DEFAULT_LAYOUTS, FIELDS_BY_TYPE } = require('../utils/nameTagBadge');
const { DEFAULT_LAYOUT: SCHEDULE_CARD_DEFAULT_LAYOUT, FIELDS: SCHEDULE_CARD_FIELDS } = require('../utils/scheduleCardBadge');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
});

test('the student Name Tag default layout has no Allergies element, but the field is still selectable', () => {
  const elements = DEFAULT_LAYOUTS.student.elements;
  assert.ok(!elements.some((el) => el.field === 'allergies'), 'Allergies should no longer be on the default name tag');
  assert.ok(
    FIELDS_BY_TYPE.student.some((f) => f.field === 'allergies'),
    'Allergies should still be offered in the field picker'
  );
});

test('the Schedule Card default layout has no Member Name element, and shows Allergy top-left in red instead', () => {
  const elements = SCHEDULE_CARD_DEFAULT_LAYOUT.elements;
  assert.ok(!elements.some((el) => el.field === 'name'), 'Member Name should no longer be on the default schedule card');
  assert.ok(
    SCHEDULE_CARD_FIELDS.some((f) => f.field === 'name'),
    'Member Name should still be offered in the field picker'
  );

  const allergyEl = elements.find((el) => el.field === 'allergy');
  assert.ok(allergyEl, 'an Allergy element should be on the default schedule card');
  assert.equal(allergyEl.color, '#dc2626', 'should be styled red, matching the name tag\'s own Allergies color');
  assert.ok(allergyEl.x <= 20, 'should sit in the top-left corner');
  assert.ok(allergyEl.y <= 20, 'should sit in the top-left corner');
});

test('scheduleCardDataForMember exposes the member\'s medical_notes as "allergy"', async () => {
  const db = require('../db');
  const { scheduleCardDataForMember } = require('../utils/scheduleCardData');
  await db.ready;

  const withAllergy = (await db
    .prepare("INSERT INTO members (name, barcode, member_type, medical_notes) VALUES ('Allergy Card Kid', 'allergy-card-kid', 'student', 'Peanut allergy')")
    .run()).lastInsertRowid;
  const withoutAllergy = (await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Allergy Kid', 'no-allergy-kid', 'student')")
    .run()).lastInsertRowid;

  const memberWith = await db.prepare('SELECT * FROM members WHERE id = ?').get(withAllergy);
  const memberWithout = await db.prepare('SELECT * FROM members WHERE id = ?').get(withoutAllergy);

  assert.equal((await scheduleCardDataForMember(memberWith)).allergy, 'Peanut allergy');
  assert.equal((await scheduleCardDataForMember(memberWithout)).allergy, '');
});
