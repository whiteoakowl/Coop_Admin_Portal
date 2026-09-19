// Shared "send an announcement" logic behind both Co-op Admin's and Main
// Admin's own Communication > Announcements tab (routes/admin-
// announcements.js, routes/main-admin-announcements.js) - a real
// request: "main admin and co-op admin announcements should be
// communication... drop down menu of who it is sent to should change to
// checkboxes so that you can choose multiple portals to send the
// announcement too." One send can now fan out to several targets at
// once (e.g. Parent + Student together), each handled the way that
// target already worked (notify() for a role, the public `announcements`
// table for "public"), with a single announcement_log row recording the
// whole send for the unified "Past Announcements" list.
const db = require('../db');
const { notify } = require('./notifications');
const { mapWithConcurrency } = require('./concurrency');

const ROLE_KEYS = ['parent', 'student', 'teacher', 'coop_admin', 'main_admin'];

// `targets` is a raw array from a checkbox group - filtered down to only
// real role keys plus the two special values ('public', 'everyone').
// 'everyone' and any specific role key can be checked together (everyone
// already covers them, but a redundant combination shouldn't error out -
// recipients naturally de-dupe below).
function normalizeTargets(targets) {
  const raw = [].concat(targets || []).map((t) => String(t).trim()).filter(Boolean);
  const valid = new Set([...ROLE_KEYS, 'public', 'everyone']);
  return [...new Set(raw.filter((t) => valid.has(t)))];
}

async function recipientAccountIdsForRole(roleKey) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT ma.id FROM member_accounts ma
       JOIN member_account_roles mar ON mar.member_account_id = ma.id
       JOIN roles r ON r.id = mar.role_id
       WHERE ma.status = 'active' AND r.key = ?`
    )
    .all(roleKey);
  return rows.map((r) => r.id);
}

async function everyoneAccountIds() {
  const rows = await db.prepare("SELECT id FROM member_accounts WHERE status = 'active'").all();
  return rows.map((r) => r.id);
}

// sentByPortal: 'main_admin' or 'coop_admin' - which Communication page
// this send came from, purely informational (both write to the same
// unified log).
async function sendAnnouncement({ title, body, targets, sentByAccountId, sentByPortal }) {
  const normalizedTargets = normalizeTargets(targets);
  let accountIds = new Set();

  if (normalizedTargets.includes('everyone')) {
    (await everyoneAccountIds()).forEach((id) => accountIds.add(id));
  } else {
    for (const target of normalizedTargets) {
      if (target === 'public') continue;
      (await recipientAccountIdsForRole(target)).forEach((id) => accountIds.add(id));
    }
  }

  // A real performance issue: this used to await notify() one recipient
  // at a time - each call several DB round trips (and, when the type's
  // auto-send is on, real email/SMS provider calls) deep - so sending to
  // "everyone" in an 800-member co-op meant several thousand fully
  // sequential network round trips on one request. 20 at a time keeps
  // this fast without opening far more concurrent DB connections/provider
  // requests than the pool (or the provider's own rate limit) can
  // actually take at once.
  await mapWithConcurrency(Array.from(accountIds), 20, (accountId) => notify(accountId, 'announcement', { title, body }));

  if (normalizedTargets.includes('public')) {
    await db.prepare('INSERT INTO announcements (title, body, is_public, created_by_account_id) VALUES (?, ?, 1, ?)').run(title, body, sentByAccountId);
  }

  await db
    .prepare('INSERT INTO announcement_log (title, body, targets, recipient_count, sent_by_portal) VALUES (?, ?, ?, ?, ?)')
    .run(title, body, JSON.stringify(normalizedTargets), accountIds.size, sentByPortal);

  return { recipientCount: accountIds.size, targets: normalizedTargets };
}

// A friendly label per target for the Past Announcements list -
// `roleLabelByKey` is { [roleKey]: label } (from the roles table, so a
// future custom role still gets a real label instead of its raw key).
function targetLabels(targets, roleLabelByKey) {
  return targets.map((t) => {
    if (t === 'everyone') return 'Everyone';
    if (t === 'public') return 'Public Homepage';
    return roleLabelByKey[t] || t;
  });
}

async function listAnnouncementLog(limit = 25) {
  const rows = await db.prepare('SELECT * FROM announcement_log ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, targets: JSON.parse(r.targets || '[]') }));
}

module.exports = { normalizeTargets, sendAnnouncement, targetLabels, listAnnouncementLog };
