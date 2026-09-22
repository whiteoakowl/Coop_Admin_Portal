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

async function getAdminPosition(id) {
  return db.prepare('SELECT * FROM admin_positions WHERE id = ?').get(id);
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

async function renameAdminPosition(id, title) {
  await db.prepare('UPDATE admin_positions SET title = ? WHERE id = ?').run(title, id);
}

async function permissionIdsForPosition(positionId) {
  return (await db.prepare('SELECT permission_id AS "id" FROM admin_position_permissions WHERE admin_position_id = ?').all(positionId)).map((r) => r.id);
}

// Whole-list replace, same "clear and re-insert" shape
// routes/main-admin.js's own POST /roles/:id/permissions already uses for
// role_permissions - confirmed with the requester that permissions belong
// to the POSITION itself (every current and future holder shares the
// same set), not configured per individual person.
async function setPositionPermissions(positionId, permissionIds) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM admin_position_permissions WHERE admin_position_id = ?').run(positionId);
    for (const permissionId of permissionIds) {
      await tx.prepare('INSERT INTO admin_position_permissions (admin_position_id, permission_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(positionId, permissionId);
    }
  });
}

// A real request: "There should not be admin check box on any of the
// membership form or profiles... Admins will simply get a star next to
// their member name." member_type's own 'admin' value (see
// partials/member-form-fields.ejs) is no longer settable from the form -
// it's derived instead, purely from whether a member holds any admin
// position at all. Holding a position also grants the Main Admin portal
// role itself (member_account_roles), same reasoning: a position with
// checked permissions is meaningless if the person still can't log into
// the portal those permissions apply to - that's the whole point of "we
// won't need a separate roles/permissions tab," an admin position now
// fully replaces both the old manual role grant AND the old manual
// Admin-type toggle.
async function syncMemberAdminStatus(memberId) {
  const countRow = await db.prepare('SELECT COUNT(*) AS "count" FROM member_admin_positions WHERE member_id = ?').get(memberId);
  const holdsAny = Number(countRow.count) > 0;

  const member = await db.prepare('SELECT member_type FROM members WHERE id = ?').get(memberId);
  if (member) {
    if (holdsAny && member.member_type !== 'admin') {
      await db.prepare("UPDATE members SET member_type = 'admin' WHERE id = ?").run(memberId);
    } else if (!holdsAny && member.member_type === 'admin') {
      await db.prepare("UPDATE members SET member_type = 'parent' WHERE id = ?").run(memberId);
    }
  }

  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(memberId);
  if (!account) return;
  const mainAdminRole = await db.prepare("SELECT id FROM roles WHERE key = 'main_admin'").get();
  if (!mainAdminRole) return;
  const hasRole = await db.prepare('SELECT 1 AS "x" FROM member_account_roles WHERE member_account_id = ? AND role_id = ?').get(account.id, mainAdminRole.id);
  if (holdsAny && !hasRole) {
    await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(account.id, mainAdminRole.id);
  } else if (!holdsAny && hasRole) {
    await db.prepare('DELETE FROM member_account_roles WHERE member_account_id = ? AND role_id = ?').run(account.id, mainAdminRole.id);
  }
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
//
// positionIds === undefined is a distinct case from null/[] - "the
// admin-positions form section wasn't actually submitted at all" (a raw
// request that skips the form, per routes/admin-members.js's own
// memberFormFields and its adminPositionsFormPresent marker), not "clear
// every position." Treating the two the same would let an incomplete
// request silently strip an existing Admin of every position - and, now
// that syncMemberAdminStatus below derives member_type/the Main Admin
// role from position count, silently demote them too.
async function syncMemberAdminPositions(memberId, positionIds) {
  if (positionIds === undefined) return;
  await db.prepare('DELETE FROM member_admin_positions WHERE member_id = ?').run(memberId);
  if (positionIds) {
    const link = db.prepare('INSERT INTO member_admin_positions (member_id, admin_position_id) VALUES (?, ?) ON CONFLICT (member_id, admin_position_id) DO NOTHING');
    for (const positionId of positionIds) await link.run(memberId, positionId);
  }
  await syncMemberAdminStatus(memberId);
}

// A real request: "there should also be a button that says add leaders.
// when you click the button it will show a drop down of members for you
// to choose. click a member then choose which admin position in the
// dropdown. save button. this adds each admin name next to their
// position." Additive (unlike syncMemberAdminPositions' full-replace
// shape above) - picking one member/position pair from the Add Leaders
// dialog should never clear whatever positions that member, or anyone
// else, already holds.
async function addAdminPositionForMember(memberId, positionId) {
  await db
    .prepare('INSERT INTO member_admin_positions (member_id, admin_position_id) VALUES (?, ?) ON CONFLICT (member_id, admin_position_id) DO NOTHING')
    .run(memberId, positionId);
  await syncMemberAdminStatus(memberId);
}

async function removeAdminPositionForMember(memberId, positionId) {
  await db.prepare('DELETE FROM member_admin_positions WHERE member_id = ? AND admin_position_id = ?').run(memberId, positionId);
  await syncMemberAdminStatus(memberId);
}

// Every current member<->position assignment, grouped by position - powers
// the Admins page's "each admin name next to their position" listing
// (and its own per-name Remove button). Returns { [positionId]: [{ id,
// name, email, phone }, ...] }, each list ordered by member name. email/
// phone are included for the Committees "pick a leader" dropdown
// (routes/main-admin-volunteers.js) and for the Admins grid's own Phone/
// Email columns, without a second query per row.
async function membersByAdminPosition() {
  const rows = await db
    .prepare(
      `SELECT map.admin_position_id AS "positionId", m.id, m.name, m.email, m.phone
       FROM member_admin_positions map JOIN members m ON m.id = map.member_id
       ORDER BY LOWER(m.name)`
    )
    .all();
  const byPosition = {};
  for (const row of rows) {
    if (!byPosition[row.positionId]) byPosition[row.positionId] = [];
    byPosition[row.positionId].push({ id: row.id, name: row.name, email: row.email, phone: row.phone });
  }
  return byPosition;
}

module.exports = {
  listAdminPositions,
  getAdminPosition,
  addAdminPosition,
  deleteAdminPosition,
  renameAdminPosition,
  permissionIdsForPosition,
  setPositionPermissions,
  syncMemberAdminStatus,
  adminPositionIdsForMember,
  adminPositionTitlesForMember,
  adminPositionTitlesForMembers,
  syncMemberAdminPositions,
  addAdminPositionForMember,
  removeAdminPositionForMember,
  membersByAdminPosition,
};
