// Coverage for a live bug report: a customized name_tag_templates row
// (saved before autoFitText existed on the "name" field, or one that took
// backfillNameTagLogo's non-destructive "leave everything else as-is"
// branch and so never picked up the flag from a fresh DEFAULT_LAYOUTS swap
// either) kept clipping a longer name instead of shrinking it to fit, on
// both the design editor and the actual printed tag - both render through
// the same shared core (public/js/name-tag-render-core.js's fitFontSize).
// Fixed with a genuine one-time backfill (backfillNameTagAutoFit, wired
// into db/index.js's db.ready chain right after backfillNameTagLogo) that
// adds autoFitText: true to the "name" and (a later follow-up request)
// "gradeLevel" fields of an existing saved row, leaving every other
// element (allergies, cleanup team, custom text, ...) exactly as saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { backfillNameTagAutoFit, backfillNameTagStackedSizing } = require('../db/bootstrapPg');

test('backfillNameTagAutoFit adds autoFitText to "name" and "gradeLevel" fields that lack it, leaving other elements untouched', async () => {
  const db = await createTestDb();
  const customized = {
    background: '#fdf0d5',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'allergies', type: 'text', field: 'allergies', x: 8, y: 80, width: 320, height: 20, fontSize: 11, color: '#dc2626', bold: false, align: 'center', valign: 'middle' },
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
  assert.equal(gradeEl.autoFitText, true, 'the gradeLevel field should also be flagged for auto-fit');
  const allergiesEl = layout.elements.find((el) => el.id === 'allergies');
  assert.equal(allergiesEl.autoFitText, undefined, 'a non-name/gradeLevel field must be left exactly as saved');
  assert.deepEqual(
    layout.elements.filter((el) => el.id !== 'name' && el.id !== 'grade'),
    customized.elements.filter((el) => el.id !== 'name' && el.id !== 'grade'),
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

test('backfillNameTagAutoFit only touches text elements whose field is "name" or "gradeLevel", not any other field named similarly', async () => {
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

// Coverage for a real follow-up request: the name field (and, for
// student, the grade field) needed real room to run a bigger font once
// each was split into 2 stacked lines - see utils/nameTagData.js's
// splitNameLines/gradeLevelLabel. backfillNameTagStackedSizing grows an
// already-saved template's height/fontSize up to at least the current
// default, without ever shrinking a genuinely larger custom size.
test('backfillNameTagStackedSizing grows a student template\'s name/grade height+fontSize up to the current default, leaving other elements untouched', async () => {
  const db = await createTestDb();
  const preStacked = {
    background: '#fdf0d5',
    backgroundOpacity: 1,
    elements: [
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'barcode', type: 'barcode', x: 68, y: 110, width: 200, height: 55 },
    ],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(preStacked), 'student');

  await backfillNameTagStackedSizing(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.background, '#fdf0d5', 'the customized background must survive untouched');
  const nameEl = layout.elements.find((el) => el.id === 'name');
  assert.equal(nameEl.height, 40);
  assert.equal(nameEl.fontSize, 22);
  const gradeEl = layout.elements.find((el) => el.id === 'grade');
  assert.equal(gradeEl.height, 36);
  assert.equal(gradeEl.fontSize, 16);
  // Position, autoFitText, and every other element are untouched - only
  // height/fontSize on these two specific elements were ever modified.
  assert.equal(nameEl.y, 26);
  assert.equal(gradeEl.y, 56);
  const memberCodeEl = layout.elements.find((el) => el.id === 'memberCode');
  assert.deepEqual(memberCodeEl, preStacked.elements[0]);
});

test('backfillNameTagStackedSizing never shrinks an already-larger custom size', async () => {
  const db = await createTestDb();
  const alreadyBig = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [{ id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 60, fontSize: 30, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true }],
  };
  await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(alreadyBig), 'student');

  await backfillNameTagStackedSizing(db);

  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const layout = JSON.parse(row.layout_json);
  const nameEl = layout.elements.find((el) => el.id === 'name');
  assert.equal(nameEl.height, 60, 'a genuinely larger custom height must survive untouched');
  assert.equal(nameEl.fontSize, 30, 'a genuinely larger custom fontSize must survive untouched');
});

test('backfillNameTagStackedSizing is a no-op for a fresh install already seeded at the current sizing', async () => {
  const db = await createTestDb();
  const beforeStudent = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const beforeParent = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('parent');

  await backfillNameTagStackedSizing(db);

  const afterStudent = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('student');
  const afterParent = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get('parent');
  assert.equal(afterStudent.layout_json, beforeStudent.layout_json);
  assert.equal(afterParent.layout_json, beforeParent.layout_json);
});
