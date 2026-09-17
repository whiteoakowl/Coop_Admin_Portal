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
const { byLastName } = require('./members');

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

// Self + every other active member sharing the account's own family_id -
// the full set of people this account can act on behalf of (register for
// an event, submit a directory/classifieds listing, etc.). Broader than
// routes/parent-portal.js's own student-only childrenForAccount: any
// portal account, not just a parent, should be able to act for its whole
// family, not only its kids. Shared here (rather than redefined per
// route file) once more than one Community & Commerce feature needed
// the exact same "who can this account act for" scope.
async function familyForAccount(accountId) {
  const self = await memberForAccount(accountId);
  if (!self) return [];
  if (!self.family_id) return [self];
  const rest = (await db.prepare('SELECT * FROM members WHERE family_id = ? AND id != ? AND active = 1').all(self.family_id, self.id)).sort(byLastName);
  return [self, ...rest];
}

// A real request: "all members should already have a portal account." A
// brand-new member (created via either portal's own New Member form) now
// gets an active account automatically at creation time, instead of
// needing a later /bulk-create-accounts pass (routes/main-admin-
// members.js's own one-shot retrofit for members added before this
// existed) - same starting password and the same two skip conditions
// that bulk pass already established: no email on file to log in with,
// or that email already belongs to a different account. createdByAccountId
// is a Main Admin portal account when the caller has one (recorded as who
// approved it) - Co-op Admin's own separate, older session-based admin
// login has no such account to attribute it to, so it's null there,
// which approved_by_account_id already allows.
async function ensurePortalAccountForMember(memberId, email, createdByAccountId) {
  const trimmedEmail = (email || '').trim();
  if (!trimmedEmail) return { status: 'no_email' };
  if (await findAccountByEmail(trimmedEmail)) return { status: 'email_in_use' };
  await db
    .prepare(
      "INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at, approved_by_account_id) VALUES (?, ?, ?, 'active', now_text(), ?)"
    )
    .run(memberId, trimmedEmail, hashPassword('changeme123'), createdByAccountId || null);
  return { status: 'created' };
}

module.exports = {
  findAccountByEmail,
  findAccountById,
  verifyPassword,
  hashPassword,
  rolesForAccount,
  permissionsForAccount,
  memberForAccount,
  familyForAccount,
  ensurePortalAccountForMember,
};
