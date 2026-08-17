// Coverage for a real request: a parent's own Monday/Wednesday setup/
// cleanup job needs to show on their name tag, day by day, at the front
// of the badge - the old cleanupTeam field only ever showed a single
// "both days smashed together" comma list, so a parent on Chairs Monday
// and Snacks Wednesday couldn't tell which team was which day from their
// tag alone. Covers utils/nameTagData.js's new mondaySetupCleanup/
// wednesdaySetupCleanup fields, the redesigned parent DEFAULT_LAYOUTS
// (utils/nameTagBadge.js), and db/bootstrapPg.js's backfillParentSetupCleanupDays
// for an already-deployed database's existing parent template.
//
// Two different db-access patterns are deliberately mixed here:
//   - badgeDataForMember/badgeDataForMembers (utils/nameTagData.js) always
//     talk to the app's own singleton `require('../db')` - the same
//     connection server.js and every route use, selected by DB_PATH/
//     DATABASE_URL at process start (see db/index.js). Those tests boot
//     the real app (server.js) against a throwaway DB_PATH, same pattern
//     as test/bulkPrintBatch.test.js.
//   - backfillParentSetupCleanupDays (db/bootstrapPg.js) takes its `db`
//     as an explicit argument instead, so it can run against an isolated,
//     disposable PGlite instance (test/pgTestDb.js's createTestDb) with no
//     server boot needed - mirrors test/badgeTemplateBackfills.test.js's
//     own pattern for the same reason.
// Mixing them in one file is fine as long as each test only ever talks to
// the db reference its own functions actually use - a test that inserts
// via createTestDb()'s db but then calls badgeDataForMember would silently
// query an entirely different, empty database (badgeDataForMember's own
// singleton), which is exactly the mistake this file's first draft made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-setup-cleanup-day-labels-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-setup-cleanup-day-labels-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createTestDb } = require('./pgTestDb');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { backfillParentSetupCleanupDays, backfillParentSetupCleanupMerge, backfillParentRemoveLegacyCleanupTeamElement } = require('../db/bootstrapPg');
const { badgeDataForMember, badgeDataForMembers } = require('../utils/nameTagData');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('the parent default layout leads with ONE shared Monday/Wednesday setup/cleanup job field, ahead of the logo/name', () => {
  const elements = DEFAULT_LAYOUTS.parent.elements;
  // A real follow-up request: the two days should "share a text space"
  // instead of sitting as two separately-positioned elements - see
  // utils/nameTagBadge.js's own comment on setupCleanupDays.
  assert.equal(elements[0].field, 'setupCleanupDays', 'the combined Monday/Wednesday job field should be the very first element');
  assert.ok(elements[0].autoFitText, 'it should shrink to fit rather than clip');
  assert.ok(!elements.some((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup'), 'the old split fields should not appear on the current default');
  const logoIdx = elements.findIndex((el) => el.type === 'image');
  assert.ok(logoIdx > 0, 'the logo (and everything else) should come after the combined job field');
});

test('badgeDataForMember: a parent on a Monday-only team gets a real Monday line and a placeholder Wednesday line', async () => {
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Chairs & Tables')").run()).lastInsertRowid;
  const parentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Monday Only Parent', 'monday-only-parent', 'parent')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentId);

  const parent = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const data = await badgeDataForMember(parent);
  assert.equal(data.mondaySetupCleanup, 'Monday: Chairs & Tables');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday: —');
  // setupCleanupDays is the same two lines as an array - the shape the
  // current default's shared element (id: setup-cleanup-days) actually
  // binds to, kept in sync with the two string fields above rather than
  // computed separately.
  assert.deepEqual(data.setupCleanupDays, ['Monday: Chairs & Tables', 'Wednesday: —']);

  // Batch version has to agree exactly - this is the same query result
  // just grouped differently, and a keying bug here would silently swap
  // one parent's day assignment onto another's card.
  const batch = await badgeDataForMembers([parent]);
  assert.deepEqual(batch[parentId], data);
});

test('badgeDataForMember: a parent on two different teams, one per day, gets both real lines', async () => {
  const mondayTeamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Chairs & Tables 2')").run()).lastInsertRowid;
  const wednesdayTeamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('wednesday', 'Snack Table')").run()).lastInsertRowid;
  const parentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Both Days Parent', 'both-days-parent', 'parent')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(mondayTeamId, parentId);
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(wednesdayTeamId, parentId);

  const parent = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const data = await badgeDataForMember(parent);
  assert.equal(data.mondaySetupCleanup, 'Monday: Chairs & Tables 2');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday: Snack Table');
  // The old combined field is untouched, still both days together - kept
  // selectable in the field picker for anyone who still wants it (see
  // utils/nameTagBadge.js's FIELDS_BY_TYPE.parent), just not on the
  // default layout anymore.
  assert.equal(data.cleanupTeam, 'Chairs & Tables 2, Snack Table');
});

test('badgeDataForMember: a parent on no team at all gets placeholders for both days, not blank lines', async () => {
  const parentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Team Parent', 'no-team-parent', 'parent')").run()).lastInsertRowid;
  const parent = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const data = await badgeDataForMember(parent);
  assert.equal(data.mondaySetupCleanup, 'Monday: —');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday: —');
});

test('backfillParentSetupCleanupDays prepends the two new fields to an already-saved parent template that predates them', async () => {
  const testDb = await createTestDb();
  // Simulate an already-deployed database: the parent template as it
  // existed before this feature - the OLD default layout, no Monday/
  // Wednesday fields at all.
  const preFeature = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 152, y: 4, width: 32, height: 32 },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 56, width: 320, height: 28, fontSize: 17, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'team', type: 'text', field: 'cleanupTeam', x: 8, y: 86, width: 320, height: 28, fontSize: 11, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
    ],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(preFeature));

  await backfillParentSetupCleanupDays(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.elements[0].field, 'mondaySetupCleanup');
  assert.equal(layout.elements[1].field, 'wednesdaySetupCleanup');
  // Every pre-existing customization (including the old logo position and
  // the old cleanupTeam line) survives untouched, just pushed after the
  // two new elements.
  assert.equal(layout.elements[2].id, 'logo');
  assert.equal(layout.elements[3].field, 'name');
  assert.equal(layout.elements[4].field, 'cleanupTeam');

  // Running it again on an already-backfilled row is a no-op, not a
  // second prepend.
  await backfillParentSetupCleanupDays(testDb);
  const rowAgain = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.deepEqual(JSON.parse(rowAgain.layout_json), layout);
});

test('backfillParentSetupCleanupDays leaves an already-current parent template (fresh install) alone', async () => {
  const testDb = await createTestDb();
  const before = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  await backfillParentSetupCleanupDays(testDb);
  const after = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.equal(after.layout_json, before.layout_json);
});

// A real follow-up request: the two lines should "share a text space"
// instead of sitting as two disconnected boxes. backfillParentSetupCleanupMerge
// migrates an already-deployed template still on the OLD two-element
// shape (whether it always was, or backfillParentSetupCleanupDays just
// added it above) onto the new shared setupCleanupDays element.
test('backfillParentSetupCleanupMerge replaces the old split monday-job/wednesday-job elements with one shared setupCleanupDays element, in place', async () => {
  const testDb = await createTestDb();
  const oldShape = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'monday-job', type: 'text', field: 'mondaySetupCleanup', x: 8, y: 4, width: 320, height: 15, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
      { id: 'wednesday-job', type: 'text', field: 'wednesdaySetupCleanup', x: 8, y: 20, width: 320, height: 15, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 152, y: 38, width: 32, height: 32 },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 92, width: 320, height: 28, fontSize: 17, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
    ],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(oldShape));

  await backfillParentSetupCleanupMerge(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  const layout = JSON.parse(row.layout_json);
  assert.ok(!layout.elements.some((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup'), 'the old split fields must be gone');
  assert.equal(layout.elements[0].field, 'setupCleanupDays', 'the merged field should land at the position of the first old element');
  assert.equal(layout.elements[0].autoFitText, true);
  // Everything else (logo, name) survives untouched, in order.
  assert.equal(layout.elements[1].id, 'logo');
  assert.equal(layout.elements[2].field, 'name');

  // Running it again is a no-op, not a second replace.
  await backfillParentSetupCleanupMerge(testDb);
  const rowAgain = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.deepEqual(JSON.parse(rowAgain.layout_json), layout);
});

test('backfillParentSetupCleanupMerge leaves an already-current parent template (fresh install, already on setupCleanupDays) alone', async () => {
  const testDb = await createTestDb();
  const before = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  await backfillParentSetupCleanupMerge(testDb);
  const after = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.equal(after.layout_json, before.layout_json);
});

test('backfillParentSetupCleanupMerge is a no-op when neither the old nor new fields exist at all (nothing to migrate)', async () => {
  const testDb = await createTestDb();
  const neither = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [{ id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true }],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(neither));

  await backfillParentSetupCleanupMerge(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.deepEqual(JSON.parse(row.layout_json), neither);
});

// Composability check: on a truly ancient database (has neither the old
// split fields nor the new merged one), running BOTH backfills in the
// db/index.js order they're actually wired in (Days, then Merge) still
// ends up on the current merged shape - not stuck on the intermediate
// split shape forever.
test('backfillParentSetupCleanupDays followed by backfillParentSetupCleanupMerge lands a pre-feature template on the current merged shape', async () => {
  const testDb = await createTestDb();
  const preFeature = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [{ id: 'name', type: 'text', field: 'name', x: 8, y: 56, width: 320, height: 28, fontSize: 17, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true }],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(preFeature));

  await backfillParentSetupCleanupDays(testDb);
  await backfillParentSetupCleanupMerge(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  const layout = JSON.parse(row.layout_json);
  assert.equal(layout.elements[0].field, 'setupCleanupDays');
  assert.equal(layout.elements[1].field, 'name');
  assert.ok(!layout.elements.some((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup'));
});

// A real bug report: a parent's printed badge showed their team/assignment
// info TWICE - once via the new setupCleanupDays element, once via a
// stale leftover { id: 'team', field: 'cleanupTeam' } element from before
// the Monday/Wednesday redesign, at its old overlapping position.
test('backfillParentRemoveLegacyCleanupTeamElement removes a stale id:"team" cleanupTeam element, leaving everything else untouched', async () => {
  const testDb = await createTestDb();
  const withLegacyElement = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'setup-cleanup-days', type: 'text', field: 'setupCleanupDays', x: 8, y: 4, width: 320, height: 32, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 152, y: 38, width: 32, height: 32 },
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 74, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'team', type: 'text', field: 'cleanupTeam', x: 8, y: 86, width: 320, height: 28, fontSize: 11, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 92, width: 320, height: 28, fontSize: 17, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
    ],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(withLegacyElement));

  await backfillParentRemoveLegacyCleanupTeamElement(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  const layout = JSON.parse(row.layout_json);
  assert.ok(!layout.elements.some((el) => el.id === 'team'), 'the stale team element must be gone');
  assert.deepEqual(
    layout.elements,
    withLegacyElement.elements.filter((el) => el.id !== 'team'),
    'every other element must survive untouched, in order'
  );
});

test('backfillParentRemoveLegacyCleanupTeamElement leaves a deliberately-added cleanupTeam element with a non-"team" id alone', async () => {
  const testDb = await createTestDb();
  const deliberate = {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'text-abc123-7', type: 'text', field: 'cleanupTeam', x: 8, y: 150, width: 320, height: 20, fontSize: 10, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
    ],
  };
  await testDb.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify(deliberate));

  await backfillParentRemoveLegacyCleanupTeamElement(testDb);

  const row = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.deepEqual(JSON.parse(row.layout_json), deliberate);
});

test('backfillParentRemoveLegacyCleanupTeamElement is a no-op for a fresh install (no legacy element at all)', async () => {
  const testDb = await createTestDb();
  const before = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  await backfillParentRemoveLegacyCleanupTeamElement(testDb);
  const after = await testDb.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  assert.equal(after.layout_json, before.layout_json);
});
