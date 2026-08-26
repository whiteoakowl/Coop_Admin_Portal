// Main Admin composes and sends an announcement to some or all members -
// a real request: notifications should show up as current + past
// announcements on the Parent Portal home page, sent by Main Admin.
// Reuses utils/notifications.js's existing notify() (the same entry
// point event registration/forum-reply/newsletter-sent confirmations
// already go through) with a new 'announcement' type key
// (supabase/migrations/20260826000000_announcement_notification_type.sql)
// rather than a parallel send mechanism - the Notification Center, the
// in-app delivery guarantee, and the email/sms provider abstraction all
// come for free this way. Distinct from Main Admin > Website's own
// "Announcements" (site_settings/announcements, shown on the PUBLIC
// homepage to anyone, signed in or not) - this is a per-account
// notification sent only to signed-in portal accounts.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const notifications = require('../utils/notifications');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('send_announcements'));

router.get('/', async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const sent = await db
    .prepare(
      `SELECT n.title, n.body, n.created_at, COUNT(*) AS "recipientCount"
       FROM notifications n WHERE n.type_key = 'announcement'
       GROUP BY n.title, n.body, n.created_at
       ORDER BY n.created_at DESC
       LIMIT 25`
    )
    .all();
  res.render('main-admin-announcements', {
    title: 'Announcements',
    roles,
    sent,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  const roleKey = (req.body.roleKey || '').trim();
  if (!title || !body) return res.redirect('/main-admin/announcements?error=' + encodeURIComponent('Title and body are required.'));

  const recipients = roleKey
    ? await db
        .prepare(
          `SELECT DISTINCT ma.id FROM member_accounts ma
           JOIN member_account_roles mar ON mar.member_account_id = ma.id
           JOIN roles r ON r.id = mar.role_id
           WHERE ma.status = 'active' AND r.key = ?`
        )
        .all(roleKey)
    : await db.prepare("SELECT id FROM member_accounts WHERE status = 'active'").all();

  for (const recipient of recipients) {
    await notifications.notify(recipient.id, 'announcement', { title, body });
  }

  res.redirect('/main-admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipients.length} member(s).`));
});

module.exports = router;
