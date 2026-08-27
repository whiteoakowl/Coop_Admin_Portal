// Main Admin > Members > Approvals/Settings tabs - a real request:
// "under members in main admin portal there should be a tab that says
// approvals. this is where new membership requests appear... there
// should be another tab under main admin members that says settings.
// this will have an approval and deny letter that can be edited by
// admin. these letters are sent automatically went approve or deny
// buttons are clicked." A "membership request" is just a member_accounts
// row still in status 'pending' - self-registration (routes/portal-
// auth.js's POST /register) already creates one per person who wanted a
// login; nothing new is created here, this is the review queue for
// those.
const db = require('../db');
const { notify } = require('./notifications');
const { formatFriendlyTimestamp } = require('./dates');

// Every pending request, plus enough context for the Approvals list's
// "each line shows primary parent name" - not necessarily the account
// holder's own name (a self-registered CHILD's pending account should
// still surface under the family's primary parent, the person who
// actually filled out the request), falling back to the account
// holder's own name for a family with no primary parent flagged yet.
async function listPendingRequests() {
  const rows = await db
    .prepare(
      `SELECT ma.id AS "accountId", ma.email, ma.created_at, m.id AS "memberId", m.name AS "memberName", m.family_id AS "familyId",
              f.name AS "familyName"
       FROM member_accounts ma
       JOIN members m ON m.id = ma.member_id
       LEFT JOIN families f ON f.id = m.family_id
       WHERE ma.status = 'pending'
       ORDER BY ma.created_at ASC`
    )
    .all();
  if (rows.length === 0) return [];

  const familyIds = [...new Set(rows.map((r) => r.familyId).filter((id) => id != null))];
  const primaryByFamily = {};
  if (familyIds.length > 0) {
    const placeholders = familyIds.map(() => '?').join(',');
    const primaries = await db
      .prepare(`SELECT family_id AS "familyId", name FROM members WHERE family_id IN (${placeholders}) AND is_primary_parent = 1`)
      .all(...familyIds);
    for (const p of primaries) primaryByFamily[p.familyId] = p.name;
  }

  return rows.map((r) => ({
    ...r,
    requestedAtLabel: formatFriendlyTimestamp(r.created_at),
    primaryParentName: (r.familyId != null && primaryByFamily[r.familyId]) || r.memberName,
  }));
}

async function getLetterTemplates() {
  const rows = await db.prepare('SELECT * FROM membership_letter_templates').all();
  const byKind = {};
  for (const r of rows) byKind[r.kind] = r;
  return byKind;
}

async function updateLetterTemplate(kind, subject, body) {
  if (kind !== 'approval' && kind !== 'denial') return;
  await db.prepare('UPDATE membership_letter_templates SET subject = ?, body = ? WHERE kind = ?').run(subject, body, kind);
}

function renderTemplate(text, name) {
  return (text || '').replace(/\{\{\s*name\s*\}\}/g, name);
}

// Sends the given letter (approval/denial) to the account, through the
// same notify() every other feature already uses - see that function's
// own header comment for why this never makes a real network call (no
// email vendor configured anywhere in this app) while still recording an
// honest, auditable attempt.
async function sendLetter(accountId, kind, recipientName) {
  const templates = await getLetterTemplates();
  const template = templates[kind];
  if (!template) return;
  const typeKey = kind === 'approval' ? 'membership_approved' : 'membership_denied';
  await notify(accountId, typeKey, {
    title: renderTemplate(template.subject, recipientName),
    body: renderTemplate(template.body, recipientName),
  });
}

// A real request: "if approve button is clicked the will recieve the
// approval email and their account is created." The account row itself
// already exists (created 'pending' at self-registration) - "created"
// here means what it functionally means to the applicant: flipping to
// 'active' is the moment their login actually starts working (see
// middleware/portalAuth.js's loadPortalSession, which only ever loads an
// 'active' account).
async function approveRequest(accountId, approvedByAccountId) {
  const account = await db.prepare('SELECT ma.*, m.name AS "memberName" FROM member_accounts ma JOIN members m ON m.id = ma.member_id WHERE ma.id = ?').get(accountId);
  if (!account) return null;
  await db.prepare("UPDATE member_accounts SET status = 'active', approved_at = now_text(), approved_by_account_id = ? WHERE id = ?").run(approvedByAccountId, accountId);
  await sendLetter(accountId, 'approval', account.memberName);
  return account;
}

async function denyRequest(accountId) {
  const account = await db.prepare('SELECT ma.*, m.name AS "memberName" FROM member_accounts ma JOIN members m ON m.id = ma.member_id WHERE ma.id = ?').get(accountId);
  if (!account) return null;
  await db.prepare("UPDATE member_accounts SET status = 'denied' WHERE id = ?").run(accountId);
  await sendLetter(accountId, 'denial', account.memberName);
  return account;
}

// The trash-can button - deletes just the request (the member_accounts
// row), never the underlying member/family profile itself. Safer than a
// full cascade: an admin can always create a fresh account for that same
// member later (Users > Create Account) if this turns out to have been a
// mistake, and the family's own membership-form data isn't lost just
// because one login request got rejected.
async function deleteRequest(accountId) {
  const account = await db.prepare('SELECT ma.*, m.name AS "memberName" FROM member_accounts ma JOIN members m ON m.id = ma.member_id WHERE ma.id = ?').get(accountId);
  if (!account) return null;
  await db.prepare('DELETE FROM member_accounts WHERE id = ?').run(accountId);
  return account;
}

module.exports = {
  listPendingRequests,
  getLetterTemplates,
  updateLetterTemplate,
  approveRequest,
  denyRequest,
  deleteRequest,
};
