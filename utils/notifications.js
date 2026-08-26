// SMS/text notification framework (Community & Commerce track, item 11).
// Shares one underlying "notification" concept with the in-app
// Notification Center, per the handoff's own suggestion, rather than
// being two unrelated systems: notify() is the single entry point every
// other feature calls (see routes/events.js's registration handler,
// routes/forums.js's reply handler, utils/newsletter.js's markSent()),
// and it always creates the in-app notification (the Notification
// Center's own data) plus attempts whatever other channels apply.
const db = require('../db');
const smsProvider = require('./smsProvider');
const emailProvider = require('./emailProvider');

async function listTypes() {
  return db.prepare('SELECT * FROM notification_types ORDER BY label').all();
}

async function getType(key) {
  return db.prepare('SELECT * FROM notification_types WHERE key = ?').get(key);
}

async function setAutoSend(key, enabled) {
  await db.prepare('UPDATE notification_types SET auto_send_enabled = ? WHERE key = ?').run(enabled ? 1 : 0, key);
}

// Merges an account's stored overrides onto the "enabled by default"
// baseline - see the migration's own comment on notification_preferences
// for why only overrides are stored.
async function preferencesForAccount(accountId) {
  const types = await listTypes();
  const overrides = await db.prepare('SELECT * FROM notification_preferences WHERE member_account_id = ?').all(accountId);
  return types.map((type) => ({
    type,
    email: overrides.find((o) => o.type_key === type.key && o.channel === 'email')?.enabled ?? 1,
    sms: overrides.find((o) => o.type_key === type.key && o.channel === 'sms')?.enabled ?? 1,
  }));
}

async function setPreference(accountId, typeKey, channel, enabled) {
  await db
    .prepare(
      `INSERT INTO notification_preferences (member_account_id, type_key, channel, enabled) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_account_id, type_key, channel) DO UPDATE SET enabled = excluded.enabled`
    )
    .run(accountId, typeKey, channel, enabled ? 1 : 0);
}

async function accountPrefersChannel(accountId, typeKey, channel) {
  const row = await db.prepare('SELECT enabled FROM notification_preferences WHERE member_account_id = ? AND type_key = ? AND channel = ?').get(accountId, typeKey, channel);
  return row ? row.enabled === 1 : true;
}

async function recordDelivery(notificationId, channel, result) {
  await db.prepare('INSERT INTO notification_deliveries (notification_id, channel, status, detail) VALUES (?, ?, ?, ?)').run(notificationId, channel, result.status, result.detail);
}

// The single entry point every feature calls to generate a
// notification. Always creates the in-app notification. If the type's
// auto_send_enabled is off, that's the only channel attempted - a Main
// Admin turning off a type's auto-send stops it from reaching email/sms
// at all, without touching code. Otherwise email/sms are each attempted
// only when the recipient hasn't opted out of that channel for this
// type.
async function notify(accountId, typeKey, { title, body, linkUrl = null } = {}) {
  const type = await getType(typeKey);
  if (!type) throw new Error(`Unknown notification type: ${typeKey}`);

  const info = await db.prepare('INSERT INTO notifications (member_account_id, type_key, title, body, link_url) VALUES (?, ?, ?, ?, ?)').run(accountId, typeKey, title, body, linkUrl);
  const notificationId = info.lastInsertRowid;
  await recordDelivery(notificationId, 'in_app', { status: 'sent', detail: null });

  if (!type.auto_send_enabled) return notificationId;

  const account = await db.prepare('SELECT ma.email, m.phone FROM member_accounts ma LEFT JOIN members m ON m.id = ma.member_id WHERE ma.id = ?').get(accountId);

  if (await accountPrefersChannel(accountId, typeKey, 'email')) {
    await recordDelivery(notificationId, 'email', await emailProvider.send(account?.email, title, body));
  } else {
    await recordDelivery(notificationId, 'email', { status: 'skipped', detail: 'Recipient opted out of this notification type by email.' });
  }
  if (await accountPrefersChannel(accountId, typeKey, 'sms')) {
    await recordDelivery(notificationId, 'sms', await smsProvider.send(account?.phone, `${title}: ${body}`));
  } else {
    await recordDelivery(notificationId, 'sms', { status: 'skipped', detail: 'Recipient opted out of this notification type by SMS.' });
  }

  return notificationId;
}

// typeKey filter added for the Parent home page's own Announcements
// section (routes/parent-portal.js) - every other existing caller
// (routes/notifications.js's own /notifications page) omits it and keeps
// seeing every type mixed together, unchanged.
async function listForAccount(accountId, { unreadOnly = false, typeKey = null } = {}) {
  if (typeKey) {
    return unreadOnly
      ? db.prepare('SELECT * FROM notifications WHERE member_account_id = ? AND type_key = ? AND read_at IS NULL ORDER BY created_at DESC').all(accountId, typeKey)
      : db.prepare('SELECT * FROM notifications WHERE member_account_id = ? AND type_key = ? ORDER BY created_at DESC').all(accountId, typeKey);
  }
  return unreadOnly
    ? db.prepare('SELECT * FROM notifications WHERE member_account_id = ? AND read_at IS NULL ORDER BY created_at DESC').all(accountId)
    : db.prepare('SELECT * FROM notifications WHERE member_account_id = ? ORDER BY created_at DESC').all(accountId);
}

async function unreadCount(accountId) {
  return Number((await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE member_account_id = ? AND read_at IS NULL').get(accountId)).c);
}

async function markRead(accountId, notificationId) {
  await db.prepare('UPDATE notifications SET read_at = now_text() WHERE id = ? AND member_account_id = ? AND read_at IS NULL').run(notificationId, accountId);
}

async function markAllRead(accountId) {
  await db.prepare('UPDATE notifications SET read_at = now_text() WHERE member_account_id = ? AND read_at IS NULL').run(accountId);
}

module.exports = {
  listTypes,
  getType,
  setAutoSend,
  preferencesForAccount,
  setPreference,
  notify,
  listForAccount,
  unreadCount,
  markRead,
  markAllRead,
};
