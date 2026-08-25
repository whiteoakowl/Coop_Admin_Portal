// Authentication and role/permission lookups for the new member-facing
// portal platform (Parent/Student/Teacher/Co-op Admin/Main Admin) - a
// completely separate login system from the single shared Admin account
// (routes/admin.js, req.session.adminId) and from the kiosk's own
// pick-your-name trust model (routes/kiosk.js, no login at all). A
// member_accounts row is the credential; roles held via
// member_account_roles determine which portals and permissions it can
// reach - see middleware/portalAuth.js for how routes enforce that.
const bcrypt = require('bcryptjs');
const db = require('../db');

async function findAccountByEmail(email) {
  return db.prepare('SELECT * FROM member_accounts WHERE LOWER(email) = LOWER(?)').get((email || '').trim());
}

async function findAccountById(id) {
  return db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
}

async function verifyPassword(account, password) {
  return bcrypt.compareSync(password || '', account.password_hash);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

// Every role a member account currently holds, e.g. [{key:'parent',...},
// {key:'teacher',...}] - the source of truth for both the portal
// switcher (one entry per role whose key is a real portal) and every
// requirePortalRole check.
async function rolesForAccount(accountId) {
  return db
    .prepare(
      `SELECT r.id, r.key, r.label, r.description
       FROM roles r
       JOIN member_account_roles mar ON mar.role_id = r.id
       WHERE mar.member_account_id = ?
       ORDER BY r.label`
    )
    .all(accountId);
}

// Every permission key granted by ANY role this account holds - a plain
// Set of strings (e.g. 'manage_classes') so a route only ever needs
// `permissions.has('manage_classes')`, never a role-name comparison.
async function permissionsForAccount(accountId) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT p.key
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN member_account_roles mar ON mar.role_id = rp.role_id
       WHERE mar.member_account_id = ?`
    )
    .all(accountId);
  return new Set(rows.map((r) => r.key));
}

// The member profile (name, family, photo, medical notes - the existing
// domain model) this login account belongs to.
async function memberForAccount(accountId) {
  return db.prepare('SELECT m.* FROM members m JOIN member_accounts ma ON ma.member_id = m.id WHERE ma.id = ?').get(accountId);
}

module.exports = {
  findAccountByEmail,
  findAccountById,
  verifyPassword,
  hashPassword,
  rolesForAccount,
  permissionsForAccount,
  memberForAccount,
};
