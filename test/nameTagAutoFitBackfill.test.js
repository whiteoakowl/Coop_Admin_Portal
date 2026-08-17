// Coverage for a live bug report: a customized name_tag_templates row
// (saved before autoFitText existed on the "name" field, or one that took
// backfillNameTagLogo's non-destructive "leave everything else as-is"
// branch and so never picked up the flag from a fresh DEFAULT_LAYOUTS swap
// either) kept clipping a longer name instead of shrinking it to fit, on
// both the design editor and the actual printed tag - both render through
// the same shared core (public/js/name-tag-render-core.js's fitFontSize).
// Fixed with a genuine one-time backfill (backfillNameTagAutoFit, wired
// into db/index.js's db.ready chain right after backfillNameTagLogo) that
// adds autoFitText: true to just the "name" field of an existing saved
// row, leaving every other element (grade, allergies, cleanup team, custom
// text, ...) exactly as saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { backfillNameTagAutoFit } = require('../db/bootstrapPg');

test('backfillNameTagAutoFit adds autoFitText to a "name" field that lacks it, leaving other elements untouched', async () => {
  const db = await createTestDb();
  const customized = {
    background: '#fdf0d5',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 110, width: 200, height: 55 },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(customized), 'student');

  await backfillNameTagAutoFit(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.background, '#fdf0d5', 'the customized background must survive untouched');
  const nameEl = layout.elements.find((el) => el.id === 'name');
  assert.equal(nameEl.autoFitText, true, 'the name field should be flagged for auto-fit');
  const gradeEl = layout.elements.find((el) => el.id === 'grade');
  assert.equal(gradeEl.autoFitText, undefined, 'a non-name field must be left exactly as saved');
  assert.deepEqual(
    layout.elements.filter((el) => el.id !== 'name'),
    customized.elements.filter((el) => el.id !== 'name'),
    'every other element must be untouched'
  );
});

test('backfillNameTagAutoFit is a no-op for a layout whose name field already has autoFitText', async () => {
  const db = await createTestDb();
  const before = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');

  await backfillNameTagAutoFit(db);

  const after = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  assert.equal(after.layout_json, before.layout_json, 'a fresh install seeded with the current (autoFitText-included) default should be untouched');
});

test('backfillNameTagAutoFit still fixes a template stored in the old bare-elements-array shape (no wrapping object)', async () => {
  const db = await createTestDb();
  // Older saved templates stored a bare elements array with no wrapping
  // { background, elements } object - see utils/nameTagData.js's
  // getTemplate, which already has to unwrap this same legacy shape on
  // every read. A real bug report: this exact row shape made the backfill
  // silently skip it forever (a bare array's .elements is undefined, so
  // the old `!Array.isArray(layout.elements)` guard always failed).
  const bareArray = [
    { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
    { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
    { id: 'barcode', type: 'barcode', x: 68, y: 110, width: 200, height: 55 },
  ];
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(bareArray), 'student');

  await backfillNameTagAutoFit(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  const nameEl = layout.elements.find((el) => el.id === 'name');
  assert.equal(nameEl.autoFitText, true, 'the name field should be flagged for auto-fit even from the legacy bare-array shape');
});

test('backfillNameTagAutoFit only touches text elements whose field is "name", not any other field named similarly', async () => {
  const db = await createTestDb();
  const customized = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'team', type: 'text', field: 'team', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'nameNote', type: 'text', field: 'custom', text: 'name tag', x: 8, y: 90, width: 320, height: 20, fontSize: 10, color: '#000', bold: false, align: 'center', valign: 'middle' },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(customized), 'parent');

  await backfillNameTagAutoFit(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('parent');
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.elements.find((el) => el.id === 'name').autoFitText, true);
  assert.equal(layout.elements.find((el) => el.id === 'team').autoFitText, undefined);
  assert.equal(layout.elements.find((el) => el.id === 'nameNote').autoFitText, undefined);
});
