// Coverage for two live bug reports, both the same root cause as
// nameTagLogoBackfill.test.js/nameTagAutoFitBackfill.test.js: seedIfMissing
// (db/bootstrapPg.js) only ever inserts a badge/schedule-card template row
// the first time the app boots against a brand new database - an install
// whose row was already seeded before a later DEFAULT_LAYOUTS/DEFAULT_LAYOUT
// change landed never picks that change up on its own, because nothing else
// ever revisits an already-saved row.
//
//   1. backfillMiscBadgeBarcode: a Setup/Cleanup badge's barcode never
//      showed on its design preview OR its printed card, because the saved
//      'setupCleanup' misc_badge_templates row predated the barcode element
//      being added to DEFAULT_LAYOUTS.setupCleanup.
//   2. backfillScheduleCardAllergy: a Schedule Card kept showing the
//      member's name with no allergy anywhere, because the saved
//      schedule_card_templates row predated the "remove name, add allergy"
//      redesign of DEFAULT_LAYOUT.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { backfillMiscBadgeBarcode, backfillScheduleCardAllergy, backfillScheduleCardAutoFit } = require('../db/bootstrapPg');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { DEFAULT_LAYOUT: SCHEDULE_CARD_DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');

test('backfillMiscBadgeBarcode adds the current default\'s barcode element to a pre-barcode setupCleanup template', async () => {
  const db = await createTestDb();
  const preBarcode = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'org', type: 'text', field: 'custom', text: 'Setup / Cleanup', x: 8, y: 6, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'number', type: 'text', field: 'badgeNumber', x: 8, y: 24, width: 320, height: 30, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'title', type: 'text', field: 'title', x: 8, y: 56, width: 320, height: 22, fontSize: 15, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'description', type: 'text', field: 'description', x: 8, y: 80, width: 320, height: 56, fontSize: 11, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
    ],
  };
  await db.prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'").run(JSON.stringify(preBarcode));

  await backfillMiscBadgeBarcode(db);

  const row = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  const layout = JSON.parse(row.layout_json);
  assert.deepEqual(layout.elements.slice(0, 4), preBarcode.elements, 'every existing element must survive untouched, in order');
  assert.equal(layout.elements.length, 5, 'exactly one element (the barcode) should have been added');
  const barcodeEl = layout.elements[4];
  assert.equal(barcodeEl.type, 'barcode');
  const currentDefault = DEFAULT_LAYOUTS.setupCleanup.elements.find((el) => el.type === 'barcode');
  assert.deepEqual(barcodeEl, currentDefault, 'the added element should match the current default barcode element exactly');
});

test('backfillMiscBadgeBarcode is a no-op for a layout that already has a barcode element', async () => {
  const db = await createTestDb();
  const before = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();

  await backfillMiscBadgeBarcode(db);

  const after = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  assert.equal(after.layout_json, before.layout_json, 'a fresh install seeded with the current (barcode-included) default should be untouched');
});

test('backfillMiscBadgeBarcode never touches the \'custom\' badge type, which has no barcode element by design', async () => {
  const db = await createTestDb();
  const before = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'custom'").get();

  await backfillMiscBadgeBarcode(db);

  const after = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'custom'").get();
  assert.equal(after.layout_json, before.layout_json);
  const layout = JSON.parse(after.layout_json);
  assert.ok(!layout.elements.some((el) => el.type === 'barcode'), 'custom badges should still have no barcode element');
});

test('backfillMiscBadgeBarcode still fixes a setupCleanup template stored in the old bare-elements-array shape (no wrapping object)', async () => {
  const db = await createTestDb();
  // Same legacy shape utils/nameTagData.js's getTemplate already has to
  // unwrap on every read (see normalizeLayout's own comment in
  // db/bootstrapPg.js) - a real bug report: this exact row shape made the
  // backfill silently skip it forever.
  const bareArray = [
    { id: 'org', type: 'text', field: 'custom', text: 'Setup / Cleanup', x: 8, y: 6, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
    { id: 'number', type: 'text', field: 'badgeNumber', x: 8, y: 24, width: 320, height: 30, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
  ];
  await db.prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'").run(JSON.stringify(bareArray));

  await backfillMiscBadgeBarcode(db);

  const row = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  const layout = JSON.parse(row.layout_json);
  assert.ok(layout.elements.some((el) => el.type === 'barcode'), 'a barcode element should have been added even from the legacy bare-array shape');
});

test('backfillScheduleCardAllergy removes a leftover "name" field element and adds the current default\'s allergy element', async () => {
  const db = await createTestDb();
  const preAllergy = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'name', type: 'text', field: 'name', x: 8, y: 5, width: 210, height: 14, fontSize: 12, color: '#1c2530', bold: true, align: 'left', valign: 'middle' },
      { id: 'parent-phone', type: 'text', field: 'primaryParentPhone', x: 222, y: 5, width: 106, height: 14, fontSize: 8, color: '#5b6b7c', bold: false, align: 'right', valign: 'middle' },
      { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 33, width: 320, height: 82, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
    ],
  };
  await db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(JSON.stringify(preAllergy));

  await backfillScheduleCardAllergy(db);

  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  const layout = JSON.parse(row.layout_json);
  assert.ok(!layout.elements.some((el) => el.field === 'name'), 'the leftover name element must be gone');
  const allergyEl = layout.elements.find((el) => el.field === 'allergy');
  assert.ok(allergyEl, 'an allergy element must have been added');
  const currentDefault = SCHEDULE_CARD_DEFAULT_LAYOUT.elements.find((el) => el.field === 'allergy');
  assert.deepEqual(allergyEl, currentDefault, 'the added element should match the current default allergy element exactly');
  assert.deepEqual(layout.elements.filter((el) => el.field !== 'allergy'), preAllergy.elements.filter((el) => el.field !== 'name'), 'every other existing element must survive untouched');
});

test('backfillScheduleCardAllergy is a no-op for a layout that already has an allergy element', async () => {
  const db = await createTestDb();
  const before = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();

  await backfillScheduleCardAllergy(db);

  const after = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  assert.equal(after.layout_json, before.layout_json, 'a fresh install seeded with the current (allergy-included) default should be untouched');
});

test('backfillScheduleCardAllergy still fixes a template stored in the old bare-elements-array shape (no wrapping object)', async () => {
  const db = await createTestDb();
  const bareArray = [
    { id: 'name', type: 'text', field: 'name', x: 8, y: 5, width: 210, height: 14, fontSize: 12, color: '#1c2530', bold: true, align: 'left', valign: 'middle' },
    { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 33, width: 320, height: 82, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
  ];
  await db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(JSON.stringify(bareArray));

  await backfillScheduleCardAllergy(db);

  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  const layout = JSON.parse(row.layout_json);
  assert.ok(!layout.elements.some((el) => el.field === 'name'), 'the leftover name element must be gone even from the legacy bare-array shape');
  assert.ok(layout.elements.some((el) => el.field === 'allergy'), 'an allergy element must have been added even from the legacy bare-array shape');
});

// A real follow-up request: a Schedule Card's allergy note kept clipping
// instead of shrinking to fit, on an already-deployed row saved (or
// backfilled by backfillScheduleCardAllergy above) before autoFitText
// existed on that field - same class of bug as
// nameTagAutoFitBackfill.test.js's coverage for the name-tag side.
test('backfillScheduleCardAutoFit adds autoFitText to allergy/primaryParentPhone fields that lack it, leaving other elements untouched', async () => {
  const db = await createTestDb();
  const preAutoFit = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'allergy', type: 'text', field: 'allergy', x: 8, y: 5, width: 210, height: 14, fontSize: 11, color: '#dc2626', bold: true, align: 'left', valign: 'middle' },
      { id: 'parent-phone', type: 'text', field: 'primaryParentPhone', x: 222, y: 5, width: 106, height: 14, fontSize: 8, color: '#5b6b7c', bold: false, align: 'right', valign: 'middle' },
      { id: 'mon-label', type: 'text', field: 'custom', text: 'Monday', x: 8, y: 21, width: 320, height: 11, fontSize: 9, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
      { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 33, width: 320, height: 82, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
    ],
  };
  await db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(JSON.stringify(preAutoFit));

  await backfillScheduleCardAutoFit(db);

  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.elements.find((el) => el.id === 'allergy').autoFitText, true);
  assert.equal(layout.elements.find((el) => el.id === 'parent-phone').autoFitText, true);
  assert.equal(layout.elements.find((el) => el.id === 'mon-label').autoFitText, undefined, 'a non-allergy/phone field must be left exactly as saved');
  assert.deepEqual(
    layout.elements.filter((el) => el.id !== 'allergy' && el.id !== 'parent-phone'),
    preAutoFit.elements.filter((el) => el.id !== 'allergy' && el.id !== 'parent-phone'),
    'every other element must be untouched'
  );
});

test('backfillScheduleCardAutoFit is a no-op for a fresh install already seeded with autoFitText', async () => {
  const db = await createTestDb();
  const before = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();

  await backfillScheduleCardAutoFit(db);

  const after = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  assert.equal(after.layout_json, before.layout_json);
});
