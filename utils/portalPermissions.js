// Portal Permissions - shared helpers behind the "Edit Permissions" bulk
// mode on both Main Admin's and Co-op Admin's own Members pages, plus the
// read-only Portal Permissions category on both portals' member profile
// pages. A real request: "portal permissions should be an admin only
// category on each member form/profile... there should be a button on
// the member page that says edit permissions. this allows you to still
// see the member list but now check boxes appear next to each name
// asking to select sections to put members in and portal permissions."
//
// "Portal permissions" here means which portal role(s) (parent/student/
// teacher/coop_admin/main_admin - see db/bootstrapPg.js's PORTAL_ROLES) a
// member's own portal login holds, NOT the granular permission checkboxes
// a role itself grants (those stay Main Admin > Roles & Permissions -
// unchanged) - a member's list-page checkbox toggles their ROLE
// membership, exactly like the existing /main-admin/users/:id/roles
// screen (routes/main-admin.js) already does one account at a time, just
// reachable in bulk from the list instead. Section assignment
// (member_sections) is unrelated to accounts at all - see
// utils/sections.js's own header comment - so it's always editable
// regardless of whether a member has a portal login yet.
const db = require('../db');

// { account, roleIds: Set<number> } - roleIds is empty (not null) when
// there's no account, so callers can treat "no account" and "account
// with no roles yet" uniformly for read purposes; only account itself
// (null vs a row) distinguishes "can't grant a role here at all" from
// "can, just hasn't yet".
async function portalStatusForMember(memberId) {
  const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
  if (!account) return { account: null, roleIds: new Set() };
  const rows = await db.prepare('SELECT role_id FROM member_account_roles WHERE member_account_id = ?').all(account.id);
  return { account, roleIds: new Set(rows.map((r) => r.role_id)) };
}

// Same shape as portalStatusForMember, batched for a whole list page - one
// query per table instead of two per row.
async function portalStatusForMembers(memberIds) {
  const result = {};
  for (const id of memberIds) result[id] = { account: null, roleIds: new Set() };
  if (memberIds.length === 0) return result;

  const placeholders = memberIds.map(() => '?').join(',');
  const accounts = await db.prepare(`SELECT * FROM member_accounts WHERE member_id IN (${placeholders})`).all(...memberIds);
  const accountIdByMemberId = {};
  for (const a of accounts) {
    result[a.member_id].account = a;
    accountIdByMemberId[a.id] = a.member_id;
  }
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return result;
  const accountPlaceholders = accountIds.map(() => '?').join(',');
  const roleRows = await db.prepare(`SELECT member_account_id, role_id FROM member_account_roles WHERE member_account_id IN (${accountPlaceholders})`).all(...accountIds);
  for (const r of roleRows) {
    const memberId = accountIdByMemberId[r.member_account_id];
    result[memberId].roleIds.add(r.role_id);
  }
  return result;
}

async function sectionIdsForMembers(memberIds) {
  const result = {};
  for (const id of memberIds) result[id] = new Set();
  if (memberIds.length === 0) return result;
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT member_id, section_id FROM member_sections WHERE member_id IN (${placeholders})`).all(...memberIds);
  for (const r of rows) result[r.member_id].add(r.section_id);
  return result;
}

// Replaces a member's ENTIRE section list with exactly `sectionIds` -
// this is a full reconcile (not an add-only), matching how the bulk
// checkbox row represents the member's complete current selection, not
// an incremental change.
async function setMemberSections(memberId, sectionIds) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM member_sections WHERE member_id = ?').run(memberId);
    for (const sectionId of sectionIds) {
      await tx.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(memberId, sectionId);
    }
  });
}

// Replaces a member's portal roles - a no-op (returns false) for a
// member with no portal account yet, since member_account_roles has
// nothing to attach to without one; granting someone their FIRST portal
// login still goes through Main Admin > Users > Create Account (the only
// place that also collects the email/password a real login needs), not
// this bulk checkbox row.
async function setMemberRoles(memberId, roleIds, grantedByAccountId) {
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(memberId);
  if (!account) return false;
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM member_account_roles WHERE member_account_id = ?').run(account.id);
    for (const roleId of roleIds) {
      await tx.prepare('INSERT INTO member_account_roles (member_account_id, role_id, granted_by_account_id) VALUES (?, ?, ?)').run(account.id, roleId, grantedByAccountId || null);
    }
  });
  return true;
}

module.exports = { portalStatusForMember, portalStatusForMembers, sectionIdsForMembers, setMemberSections, setMemberRoles };
