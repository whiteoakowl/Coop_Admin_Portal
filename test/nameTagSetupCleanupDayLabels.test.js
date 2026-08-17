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
const { backfillParentSetupCleanupDays } = require('../db/bootstrapPg');
const { badgeDataForMember, badgeDataForMembers } = require('../utils/nameTagData');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('the parent default layout leads with Monday/Wednesday setup/cleanup job fields, ahead of the logo/name', () => {
  const elements = DEFAULT_LAYOUTS.parent.elements;
  assert.equal(elements[0].field, 'mondaySetupCleanup', 'Monday job should be the very first element');
  assert.equal(elements[1].field, 'wednesdaySetupCleanup', 'Wednesday job should be second');
  assert.ok(elements[0].autoFitText && elements[1].autoFitText, 'both should shrink to fit rather than clip');
  const logoIdx = elements.findIndex((el) => el.type === 'image');
  assert.ok(logoIdx > 1, 'the logo (and everything else) should come after both job lines');
});

test('badgeDataForMember: a parent on a Monday-only team gets a real Monday line and a placeholder Wednesday line', async () => {
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Chairs & Tables')").run()).lastInsertRowid;
  const parentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Monday Only Parent', 'monday-only-parent', 'parent')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentId);

  const parent = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentId);
  const data = await badgeDataForMember(parent);
  assert.equal(data.mondaySetupCleanup, 'Monday: Chairs & Tables');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday: —');

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
