// Co-op Admin's own Announcements (mounted at /admin/announcements,
// server.js) - a real request: "be able to create separate announcements
// for parent, student and teacher portal. Can do this from the main
// admin and co-op admin portals." Functionally identical to Main Admin's
// own Announcements (routes/main-admin-announcements.js) - same
// notifications.notify() 'announcement' type, same role-targeted "Send
// to" dropdown (any role, including parent/student/teacher separately) -
// just gated behind the Co-op Admin session (requireAdmin) instead of a
// Main Admin portal account, since this app's Co-op Admin Portal is the
// original single shared admin login, a completely separate identity
// system from the newer member_accounts-based portals (see routes/admin.js's
// own header comment).
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const notifications = require('../utils/notifications');

router.get('/announcements', requireAdmin, async (req, res) => {
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
  res.render('admin-announcements', {
    title: 'Announcements',
    roles,
    sent,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/announcements', requireAdmin, async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  const roleKey = (req.body.roleKey || '').trim();
  if (!title || !body) return res.redirect('/admin/announcements?error=' + encodeURIComponent('Title and body are required.'));

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

  res.redirect('/admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipients.length} member(s).`));
});

module.exports = router;
