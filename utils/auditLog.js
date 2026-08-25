// Audit Log (Community & Commerce track, item 13) - record() is called
// directly from admin route handlers (not from inside every utils/*.js
// mutation function) right after the real action already succeeded, so
// this stays a thin, honest record of what an admin actually did rather
// than a generic hook fired on every database write.
const db = require('../db');

async function record(actorAccountId, action, targetType, targetId, detail) {
  await db.prepare('INSERT INTO audit_log (actor_account_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)').run(actorAccountId, action, targetType, targetId, detail || null);
}

async function list({ targetType, limit = 200 } = {}) {
  return targetType
    ? db.prepare('SELECT al.*, ma.email AS actor_email FROM audit_log al LEFT JOIN member_accounts ma ON ma.id = al.actor_account_id WHERE al.target_type = ? ORDER BY al.created_at DESC LIMIT ?').all(targetType, limit)
    : db.prepare('SELECT al.*, ma.email AS actor_email FROM audit_log al LEFT JOIN member_accounts ma ON ma.id = al.actor_account_id ORDER BY al.created_at DESC LIMIT ?').all(limit);
}

async function targetTypes() {
  const rows = await db.prepare('SELECT DISTINCT target_type FROM audit_log ORDER BY target_type').all();
  return rows.map((r) => r.target_type);
}

module.exports = { record, list, targetTypes };
