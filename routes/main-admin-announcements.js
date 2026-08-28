// Main Admin's Communication hub - a real request: "main admin and co-op
// admin announcements should be communication, and it should have 4 tabs:
// announcements, email, text, and newsletter." This file still only owns
// the Announcements tab (Email/Text are their own not-yet-built routes,
// Newsletter reuses the existing routes/admin-newsletter.js unchanged -
// see views/main-admin-communication-announcements.ejs's tab bar). Sending
// itself is shared with Co-op Admin's identical tab via
// utils/announcements.js, which also owns the unified "Past Announcements"
// log (announcement_log) - the old per-portal "Recently Sent" table
// (grouped notifications rows) and the separate "Public Homepage
// Announcements" section are both gone in favor of that one log.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const announcements = require('../utils/announcements');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('send_announcements'));

router.get('/', async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const roleLabelByKey = Object.fromEntries(roles.map((r) => [r.key, r.label]));
  const log = await announcements.listAnnouncementLog();
  res.render('main-admin-announcements', {
    title: 'Communication',
    roles,
    log,
    targetLabels: (targets) => announcements.targetLabels(targets, roleLabelByKey),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  const targets = announcements.normalizeTargets(req.body.targets);
  if (!title || !body) return res.redirect('/main-admin/announcements?error=' + encodeURIComponent('Title and body are required.'));
  if (targets.length === 0) return res.redirect('/main-admin/announcements?error=' + encodeURIComponent('Choose at least one recipient.'));

  const { recipientCount } = await announcements.sendAnnouncement({
    title,
    body,
    targets,
    sentByAccountId: req.portalAccount.id,
    sentByPortal: 'main_admin',
  });

  res.redirect('/main-admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

// Email/Text composer tabs (items 12/13) aren't built yet - these keep
// the 4-tab Communication bar fully clickable in the meantime rather than
// linking to a 404.
router.get('/email', (req, res) => {
  res.render('main-admin-communication-coming-soon', { title: 'Communication', activeTab: 'email' });
});
router.get('/text', (req, res) => {
  res.render('main-admin-communication-coming-soon', { title: 'Communication', activeTab: 'text' });
});

module.exports = router;
