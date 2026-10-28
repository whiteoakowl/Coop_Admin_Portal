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

// A real request: "two columns of checkboxes titled text and email.
// Admin can click each box to select if it will be a text notification,
// email notification or both." Replaces the old single combined
// auto_send_enabled toggle with two fully independent per-channel
// switches on the same notification_types row.
async function setChannelsEnabled(key, { textEnabled, emailEnabled }) {
  await db.prepare('UPDATE notification_types SET sms_enabled = ?, email_enabled = ? WHERE key = ?').run(textEnabled ? 1 : 0, emailEnabled ? 1 : 0, key);
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
    // A real request: "a notifications settings card to control email,
    // text and push notifications." No real push-delivery mechanism
    // exists yet (see this file's own notify() - only email/sms are
    // ever attempted) - this preference saves and shows correctly today,
    // ready for whenever a real push channel is wired up.
    push: overrides.find((o) => o.type_key === type.key && o.channel === 'push')?.enabled ?? 1,
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
// notification. Always creates the in-app notification. email_enabled
// and sms_enabled are each independent, admin-controlled ceilings per
// type (the Notifications settings page's own two checkbox columns) -
// a type with both off behaves exactly like the old auto_send_enabled
// off did (in-app only). On top of whichever channels the type itself
// allows, a recipient's own per-account preference can still opt that
// one account out of a channel the type otherwise permits.
async function notify(accountId, typeKey, { title, body, linkUrl = null, mediaUrl = null } = {}) {
  const type = await getType(typeKey);
  if (!type) throw new Error(`Unknown notification type: ${typeKey}`);

  const info = await db.prepare('INSERT INTO notifications (member_account_id, type_key, title, body, link_url) VALUES (?, ?, ?, ?, ?)').run(accountId, typeKey, title, body, linkUrl);
  const notificationId = info.lastInsertRowid;
  await recordDelivery(notificationId, 'in_app', { status: 'sent', detail: null });

  const account = await db.prepare('SELECT ma.email, m.phone FROM member_accounts ma LEFT JOIN members m ON m.id = ma.member_id WHERE ma.id = ?').get(accountId);

  if (type.email_enabled && (await accountPrefersChannel(accountId, typeKey, 'email'))) {
    await recordDelivery(notificationId, 'email', await emailProvider.send(account?.email, title, body));
  } else {
    const detail = type.email_enabled ? 'Recipient opted out of this notification type by email.' : 'This notification type is text-only - email is never sent for it.';
    await recordDelivery(notificationId, 'email', { status: 'skipped', detail });
  }
  if (type.sms_enabled && (await accountPrefersChannel(accountId, typeKey, 'sms'))) {
    await recordDelivery(notificationId, 'sms', await smsProvider.send(account?.phone, `${title}: ${body}`, mediaUrl));
  } else {
    const detail = type.sms_enabled ? 'Recipient opted out of this notification type by SMS.' : 'This notification type is email-only - text is never sent for it.';
    await recordDelivery(notificationId, 'sms', { status: 'skipped', detail });
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
  setChannelsEnabled,
  preferencesForAccount,
  setPreference,
  notify,
  listForAccount,
  unreadCount,
  markRead,
  markAllRead,
};
