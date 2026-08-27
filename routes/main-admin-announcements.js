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
const { sanitizePostBody } = require('../utils/sanitizeHtml');

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
  // Public homepage posts (site_settings/announcements) - a real
  // request: "the public home page announcements should be listed under
  // the announcements tab" - management for these used to live only on
  // Main Admin > Website (routes/main-admin.js's own /website/
  // announcements POST/delete, unchanged and still what this list's own
  // delete forms post to); this page is now the other place they show
  // up and get created from (see the roleKey === 'public' branch below).
  const publicAnnouncements = await db.prepare('SELECT * FROM announcements ORDER BY published_at DESC').all();
  res.render('main-admin-announcements', {
    title: 'Announcements',
    roles,
    sent,
    publicAnnouncements,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  const roleKey = (req.body.roleKey || '').trim();
  if (!title || !body) return res.redirect('/main-admin/announcements?error=' + encodeURIComponent('Title and body are required.'));

  // "Public" isn't a portal role - it means posting to the public
  // homepage (site_settings/announcements) instead of sending an
  // in-app/email notification to signed-in members, so it's handled as
  // its own branch rather than falling into the recipients query below.
  if (roleKey === 'public') {
    await db.prepare('INSERT INTO announcements (title, body, is_public, created_by_account_id) VALUES (?, ?, ?, ?)').run(title, body, 1, req.portalAccount.id);
    return res.redirect('/main-admin/announcements?notice=' + encodeURIComponent('Posted to the public homepage.'));
  }

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
