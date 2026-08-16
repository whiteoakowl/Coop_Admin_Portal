// Coverage for a live bug report: the owl crest logo added to
// DEFAULT_LAYOUTS.student/parent (utils/nameTagBadge.js) never showed up
// on the real, already-deployed production site. Root cause: seedIfMissing
// (db/bootstrapPg.js) only ever inserts a name_tag_templates row the first
// time the app boots against a brand new database - an install whose
// student/parent row was already seeded before the logo was added to
// DEFAULT_LAYOUTS never gets touched again, so the new default only ever
// reached a fresh install, never a real one. Fixed with a genuine one-time
// backfill (backfillNameTagLogo, wired into db/index.js's db.ready chain
// right after seedIfMissing) that patches an EXISTING saved row instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { backfillNameTagLogo } = require('../db/bootstrapPg');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');

test('backfillNameTagLogo replaces an unmodified pre-logo default wholesale with the new, fully-repositioned default', async () => {
  const db = await createTestDb();
  const preLogoStudent = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 110, width: 200, height: 55 },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(preLogoStudent), 'student');

  await backfillNameTagLogo(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  assert.deepEqual(layout, DEFAULT_LAYOUTS.student, 'an unmodified pre-logo default should be replaced with the current default, logo included');
});

test('backfillNameTagLogo is a no-op for a layout that already has a logo (or any image element)', async () => {
  const db = await createTestDb();
  const before = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');

  await backfillNameTagLogo(db);

  const after = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  assert.equal(after.layout_json, before.layout_json, 'a fresh install seeded with the current (logo-included) default should be untouched');
});

test('backfillNameTagLogo non-destructively adds just a logo element to a customized layout, leaving every existing element untouched', async () => {
  const db = await createTestDb();
  const customized = {
    background: '#fdf0d5',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 110, width: 200, height: 55 },
      { id: 'customNote', type: 'text', field: 'custom', text: 'Welcome!', x: 8, y: 170, width: 320, height: 20, fontSize: 10, color: '#000', bold: false, align: 'center', valign: 'middle' },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(customized), 'student');

  await backfillNameTagLogo(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.background, '#fdf0d5', 'the customized background must survive untouched');
  assert.deepEqual(layout.elements.slice(1), customized.elements, 'every existing element, including the custom one, must be untouched and in the same order');
  assert.equal(layout.elements[0].type, 'image', 'a logo element should be added, not blended into the existing ones');
  assert.equal(layout.elements[0].src, '/img/logo-owl.png');
});
