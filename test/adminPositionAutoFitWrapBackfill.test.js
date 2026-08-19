// Coverage for a live bug report, screenshot: a longer single admin
// position ("Community Service Coordinator", "Parent Support Coordinator")
// wrapped onto 2-3 lines and got clipped at the box's own top edge, even
// after DEFAULT_LAYOUTS.admin's own "position" element gained
// autoFitText+autoFitWrap support - the exact same "editing DEFAULT_LAYOUTS
// never reaches an already-saved row" bug test/nameTagAutoFitBackfill.
// test.js exists for, just for this one field/flag pair.
// backfillAdminPositionAutoFitWrap (wired into db/index.js's db.ready
// chain, right after backfillNameTagStackedSizing) heals an existing
// saved 'admin' template's "position" element in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { backfillAdminPositionAutoFitWrap } = require('../db/bootstrapPg');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');

test('backfillAdminPositionAutoFitWrap forces autoFitText+autoFitWrap on a saved position element that lacks either, leaving other elements untouched', async () => {
  const db = await createTestDb();
  const preWrap = {
    background: '#fdf0d5',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 50, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 68, width: 320, height: 40, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'position', type: 'text', field: 'adminPosition', x: 8, y: 110, width: 320, height: 36, fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 154, width: 200, height: 55 },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(preWrap), 'admin');

  await backfillAdminPositionAutoFitWrap(db);

  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'admin'").get();
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.background, '#fdf0d5', 'the customized background must survive untouched');
  const position = layout.elements.find((el) => el.id === 'position');
  assert.equal(position.autoFitText, true, 'position should be flagged for auto-fit');
  assert.equal(position.autoFitWrap, true, 'position should be flagged to wrap up to a few lines, not stay on one');
  assert.equal(position.height, DEFAULT_LAYOUTS.admin.elements.find((el) => el.id === 'position').height, 'height should grow to at least the current default so 2 lines have room');
  const nameEl = layout.elements.find((el) => el.id === 'name');
  assert.deepEqual(nameEl, preWrap.elements[1], 'the name field must be left exactly as saved');
  const memberCodeEl = layout.elements.find((el) => el.id === 'memberCode');
  assert.deepEqual(memberCodeEl, preWrap.elements[0], 'every other element must be untouched');
});

test('backfillAdminPositionAutoFitWrap never shrinks an already-larger custom height', async () => {
  const db = await createTestDb();
  const alreadyTall = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [{ id: 'position', type: 'text', field: 'adminPosition', x: 8, y: 110, width: 320, height: 60, fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle' }],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(alreadyTall), 'admin');

  await backfillAdminPositionAutoFitWrap(db);

  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'admin'").get();
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.elements.find((el) => el.id === 'position').height, 60, 'a genuinely larger custom height must survive untouched');
});

test('backfillAdminPositionAutoFitWrap still fixes a template stored in the old bare-elements-array shape', async () => {
  const db = await createTestDb();
  const bareArray = [
    { id: 'position', type: 'text', field: 'adminPosition', x: 8, y: 110, width: 320, height: 36, fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
    { id: 'barcode', type: 'barcode', x: 68, y: 154, width: 200, height: 55 },
  ];
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(bareArray), 'admin');

  await backfillAdminPositionAutoFitWrap(db);

  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'admin'").get();
  const layout = JSON.parse(row.layout_json);
  const position = layout.elements.find((el) => el.id === 'position');
  assert.equal(position.autoFitText, true);
  assert.equal(position.autoFitWrap, true);
});

test('backfillAdminPositionAutoFitWrap is a no-op for a fresh install already seeded at the current default', async () => {
  const db = await createTestDb();
  const before = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'admin'").get();

  await backfillAdminPositionAutoFitWrap(db);

  const after = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'admin'").get();
  assert.equal(after.layout_json, before.layout_json);
});

test('DEFAULT_LAYOUTS.admin position element has autoFitText and autoFitWrap set', () => {
  const position = DEFAULT_LAYOUTS.admin.elements.find((el) => el.id === 'position');
  assert.equal(position.autoFitText, true);
  assert.equal(position.autoFitWrap, true);
});
