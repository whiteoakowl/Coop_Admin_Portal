// Co-op Admin's Communication hub (mounted at /admin/announcements,
// server.js) - a real request: "main admin and co-op admin announcements
// should be communication, and it should have 4 tabs: announcements,
// email, text, and newsletter." Functionally identical to Main Admin's
// own Communication > Announcements tab (routes/main-admin-
// announcements.js) - both share utils/announcements.js's send logic and
// unified announcement_log - just gated behind the Co-op Admin session
// (requireAdmin) instead of a Main Admin portal account, since this app's
// Co-op Admin Portal is the original single shared admin login, a
// completely separate identity system from the newer member_accounts-based
// portals (see routes/admin.js's own header comment). That's also why
// sentByAccountId is always null here - the shared admin login has no
// member_accounts row to attribute the send to.
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const announcements = require('../utils/announcements');

router.get('/announcements', requireAdmin, async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const roleLabelByKey = Object.fromEntries(roles.map((r) => [r.key, r.label]));
  const log = await announcements.listAnnouncementLog();
  res.render('admin-announcements', {
    title: 'Communication',
    roles,
    log,
    targetLabels: (targets) => announcements.targetLabels(targets, roleLabelByKey),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/announcements', requireAdmin, async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  const targets = announcements.normalizeTargets(req.body.targets);
  if (!title || !body) return res.redirect('/admin/announcements?error=' + encodeURIComponent('Title and body are required.'));
  if (targets.length === 0) return res.redirect('/admin/announcements?error=' + encodeURIComponent('Choose at least one recipient.'));

  const { recipientCount } = await announcements.sendAnnouncement({
    title,
    body,
    targets,
    sentByAccountId: null,
    sentByPortal: 'coop_admin',
  });

  res.redirect('/admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

// Email/Text composer tabs (items 12/13) aren't built yet - these keep
// the 4-tab Communication bar fully clickable in the meantime rather than
// linking to a 404.
router.get('/announcements/email', requireAdmin, (req, res) => {
  res.render('admin-communication-coming-soon', { title: 'Communication', activeTab: 'email' });
});
router.get('/announcements/text', requireAdmin, (req, res) => {
  res.render('admin-communication-coming-soon', { title: 'Communication', activeTab: 'text' });
});

module.exports = router;
