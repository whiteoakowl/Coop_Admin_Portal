// Coverage for a real request: "when someone is assigned to a setup/
// cleanup team it will be listed on all of the parents/adults name tags
// on that families account." Before this, a parent's name tag only ever
// showed THEIR OWN setup/cleanup assignment (utils/nameTagData.js's old
// cleanupTeamRowsForParent) - if only one parent in a two-parent family
// signed up, the other parent's tag showed no team at all. Now every
// parent name tag pulls from the whole family (cleanupTeamRowsForFamily/
// cleanupTeamRowsForFamilies), so any team assignment held by ANY parent
// in the family shows up on ALL of that family's parent tags.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-setup-cleanup-family-wide-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-setup-cleanup-family-wide-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { badgeDataForMember, badgeDataForMembers } = require('../utils/nameTagData');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('badgeDataForMember: a parent whose SPOUSE (not themselves) is on a team still gets that team on their own tag', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Family Wide Test Family')").run()).lastInsertRowid;
  const signedUpId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Signed Up Parent', 'signed-up-parent', 'parent', ?)").run(familyId)).lastInsertRowid;
  const spouseId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Spouse Parent', 'spouse-parent', 'parent', ?)").run(familyId)).lastInsertRowid;
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Family Wide Team')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, signedUpId);

  const spouse = await db.prepare('SELECT * FROM members WHERE id = ?').get(spouseId);
  const data = await badgeDataForMember(spouse);
  assert.equal(data.mondaySetupCleanup, 'Monday - Family Wide Team', 'the spouse who never joined the team directly should still see it on their own tag');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday - —');

  // The signed-up parent's own tag shows the exact same thing - both
  // parents' tags read identically for a shared family assignment.
  const signedUp = await db.prepare('SELECT * FROM members WHERE id = ?').get(signedUpId);
  const signedUpData = await badgeDataForMember(signedUp);
  assert.equal(signedUpData.mondaySetupCleanup, 'Monday - Family Wide Team');
});

test('badgeDataForMembers (batch): the same family-wide sharing holds for the bulk-print path, keyed correctly per member', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Family Wide Batch Family')").run()).lastInsertRowid;
  const signedUpId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Batch Signed Up', 'batch-signed-up', 'parent', ?)").run(familyId)).lastInsertRowid;
  const spouseId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Batch Spouse', 'batch-spouse', 'parent', ?)").run(familyId)).lastInsertRowid;
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('wednesday', 'Batch Family Team')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, signedUpId);

  // An unrelated family, no team at all - must not pick up the other
  // family's assignment.
  const otherFamilyId = (await db.prepare("INSERT INTO families (name) VALUES ('Unrelated Family')").run()).lastInsertRowid;
  const otherParentId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Unrelated Parent', 'unrelated-parent', 'parent', ?)").run(otherFamilyId)).lastInsertRowid;

  const members = await db
    .prepare(`SELECT * FROM members WHERE id IN (${signedUpId}, ${spouseId}, ${otherParentId})`)
    .all();
  const dataByMember = await badgeDataForMembers(members);

  assert.equal(dataByMember[spouseId].wednesdaySetupCleanup, 'Wednesday - Batch Family Team', 'the spouse should see the family\'s team even in the batch path');
  assert.equal(dataByMember[signedUpId].wednesdaySetupCleanup, 'Wednesday - Batch Family Team');
  assert.equal(dataByMember[otherParentId].wednesdaySetupCleanup, 'Wednesday - —', 'an unrelated family must never pick up another family\'s assignment');
});

test('a family-less parent (no family_id at all) still only ever sees their own assignment', async () => {
  const loneId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Lone Parent No Team', 'lone-parent-no-team', 'parent')").run()).lastInsertRowid;
  const lone = await db.prepare('SELECT * FROM members WHERE id = ?').get(loneId);
  const data = await badgeDataForMember(lone);
  assert.equal(data.mondaySetupCleanup, 'Monday - —');
  assert.equal(data.wednesdaySetupCleanup, 'Wednesday - —');
});

test('two family members sharing the same team are not double-listed on either tag', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Double List Test Family')").run()).lastInsertRowid;
  const parentAId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Double List A', 'double-list-a', 'parent', ?)").run(familyId)).lastInsertRowid;
  const parentBId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Double List B', 'double-list-b', 'parent', ?)").run(familyId)).lastInsertRowid;
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Shared Team')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentAId);
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentBId);

  const parentA = await db.prepare('SELECT * FROM members WHERE id = ?').get(parentAId);
  const data = await badgeDataForMember(parentA);
  assert.equal(data.mondaySetupCleanup, 'Monday - Shared Team', 'the shared team should appear exactly once, not "Shared Team, Shared Team"');
});
