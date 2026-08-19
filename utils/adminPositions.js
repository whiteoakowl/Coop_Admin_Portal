// Settings-managed list of admin/leader position titles (e.g.
// "President", "Treasurer") - a real request: "Under this tab you can add
// a list of admin positions. This list will then appear on the member
// form as a choice in the admin position dropdown menu." Deliberately
// flat (no sections, no reordering) - just add/delete, ordered by
// insertion order via `position`, the simplest shape that satisfies the
// request. Mirrors utils/taskList.js's add/delete pair, just without that
// module's section nesting or barcode badge side effects (an admin
// position is a label on a badge, not a scannable item of its own).
const db = require('../db');

async function listAdminPositions() {
  return db.prepare('SELECT * FROM admin_positions ORDER BY position, LOWER(title)').all();
}

async function nextPosition() {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM admin_positions').get();
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

// Title is unique (see the admin_positions.title UNIQUE constraint) - a
// duplicate add is silently treated as a no-op success (ON CONFLICT DO
// NOTHING) rather than a 500, the same "adding the same thing twice isn't
// an error" convention families' own add-family flow already follows.
async function addAdminPosition(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;
  const info = await db
    .prepare('INSERT INTO admin_positions (title, position) VALUES (?, ?) ON CONFLICT (title) DO NOTHING')
    .run(trimmed, await nextPosition());
  return info.lastInsertRowid || null;
}

// ON DELETE CASCADE on member_admin_positions.admin_position_id (see
// db/migrations' member_admin_positions table) means this never needs to
// touch that table itself - deleting a position off the list just drops
// anyone's link to it automatically at the database level, same as
// setup_teams' own leader_id/members relationship.
async function deleteAdminPosition(id) {
  await db.prepare('DELETE FROM admin_positions WHERE id = ?').run(id);
}

// A real request: "ability to add unlimited admin positions to a member
// profile" - members.admin_position_id (single, nullable FK) is
// superseded by member_admin_positions, a proper many-to-many join table
// (20260819000000_member_admin_positions.sql), same shape as
// setup_team_members. Ordered by admin_positions' own list order (its
// `position` column, the same order the Settings > Admin & Leaders list
// itself shows), not insertion order, so a member's badge/profile always
// lists their positions in the co-op's own configured order regardless of
// which one was picked first on the form.
async function adminPositionIdsForMember(memberId) {
  return (
    await db
      .prepare(
        `SELECT map.admin_position_id AS "id" FROM member_admin_positions map
         JOIN admin_positions ap ON ap.id = map.admin_position_id
         WHERE map.member_id = ? ORDER BY ap.position, LOWER(ap.title)`
      )
      .all(memberId)
  ).map((r) => r.id);
}

async function adminPositionTitlesForMember(memberId) {
  return (
    await db
      .prepare(
        `SELECT ap.title FROM member_admin_positions map
         JOIN admin_positions ap ON ap.id = map.admin_position_id
         WHERE map.member_id = ? ORDER BY ap.position, LOWER(ap.title)`
      )
      .all(memberId)
  ).map((r) => r.title);
}

// Batch version of adminPositionTitlesForMember for a bulk print flow
// (utils/nameTagData.js's badgeDataForMembers) - one query for the whole
// batch instead of one per member, the same N+1 shape already fixed
// elsewhere in this app for a real ~800-member bulk print timeout (see
// cleanupTeamRowsForParents' own comment in utils/nameTagData.js). Returns
// { [memberId]: [title, ...] }.
async function adminPositionTitlesForMembers(memberIds) {
  if (memberIds.length === 0) return {};
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT map.member_id AS "memberId", ap.title FROM member_admin_positions map
       JOIN admin_positions ap ON ap.id = map.admin_position_id
       WHERE map.member_id IN (${placeholders}) ORDER BY ap.position, LOWER(ap.title)`
    )
    .all(...memberIds);
  const byMember = {};
  for (const row of rows) {
    if (!byMember[row.memberId]) byMember[row.memberId] = [];
    byMember[row.memberId].push(row.title);
  }
  return byMember;
}

// Replaces a member's full set of admin positions - same "always clear
// existing rows first" pattern as routes/admin-members.js's own
// syncCleanupTeams, so saving the member form with every checkbox
// unchecked correctly clears a member who's no longer holding any
// position (e.g. converted away from admin), not just a no-op.
async function syncMemberAdminPositions(memberId, positionIds) {
  await db.prepare('DELETE FROM member_admin_positions WHERE member_id = ?').run(memberId);
  if (!positionIds) return;
  const link = db.prepare('INSERT INTO member_admin_positions (member_id, admin_position_id) VALUES (?, ?) ON CONFLICT (member_id, admin_position_id) DO NOTHING');
  for (const positionId of positionIds) await link.run(memberId, positionId);
}

module.exports = {
  listAdminPositions,
  addAdminPosition,
  deleteAdminPosition,
  adminPositionIdsForMember,
  adminPositionTitlesForMember,
  adminPositionTitlesForMembers,
  syncMemberAdminPositions,
};
