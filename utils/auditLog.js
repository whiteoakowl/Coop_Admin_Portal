// Audit Log (Community & Commerce track, item 13) - record() is called
// directly from admin route handlers (not from inside every utils/*.js
// mutation function) right after the real action already succeeded, so
// this stays a thin, honest record of what an admin actually did rather
// than a generic hook fired on every database write.
const db = require('../db');

async function record(actorAccountId, action, targetType, targetId, detail) {
  await db.prepare('INSERT INTO audit_log (actor_account_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)').run(actorAccountId, action, targetType, targetId, detail || null);
}

// limit=200 by default for every existing caller that just wants a
// recent-activity snapshot (e.g. Accounting's own inline payment_charge
// history). Pass limit: null (the Audit Log page itself does, ahead of
// its own in-memory pagination - see utils/pagination.js's own header
// comment on why that's the right place to paginate, not a second SQL
// round-trip here) to fetch every matching row with no LIMIT clause at
// all.
async function list({ targetType, limit = 200 } = {}) {
  const hasLimit = limit !== null && limit !== undefined;
  const sql = targetType
    ? `SELECT al.*, ma.email AS actor_email FROM audit_log al LEFT JOIN member_accounts ma ON ma.id = al.actor_account_id WHERE al.target_type = ? ORDER BY al.created_at DESC${hasLimit ? ' LIMIT ?' : ''}`
    : `SELECT al.*, ma.email AS actor_email FROM audit_log al LEFT JOIN member_accounts ma ON ma.id = al.actor_account_id ORDER BY al.created_at DESC${hasLimit ? ' LIMIT ?' : ''}`;
  const params = targetType ? [targetType] : [];
  if (hasLimit) params.push(limit);
  return db.prepare(sql).all(...params);
}

async function targetTypes() {
  const rows = await db.prepare('SELECT DISTINCT target_type FROM audit_log ORDER BY target_type').all();
  return rows.map((r) => r.target_type);
}

module.exports = { record, list, targetTypes };
