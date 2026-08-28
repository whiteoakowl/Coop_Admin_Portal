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
const emailComposer = require('../utils/emailComposer');

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

// Communication > Email tab (item 12): filter popup + checkbox member
// list, "Create Email" -> compose screen, send now or schedule for
// later. See routes/main-admin-announcements.js's identical tab and
// utils/emailComposer.js's own header comment - same shared logic, just
// gated behind the Co-op Admin session per this file's own header
// comment.
router.get('/announcements/email', requireAdmin, async (req, res) => {
  const [roles, sections, gradeLevels, candidates, campaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    emailComposer.listCampaigns(),
  ]);
  res.render('admin-email', {
    title: 'Communication',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    campaigns,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/announcements/email/compose', requireAdmin, async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (recipientIds.length === 0) return res.redirect('/admin/announcements/email?error=' + encodeURIComponent('Select at least one recipient.'));

  const candidates = await emailComposer.listRecipientCandidates();
  const recipients = candidates.filter((c) => recipientIds.includes(c.accountId));
  res.render('admin-email-compose', {
    title: 'Compose Email',
    recipients,
    error: null,
  });
});

router.post('/announcements/email/send', requireAdmin, async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const subject = (req.body.subject || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  const replyTo = (req.body.replyTo || '').trim();
  const sendOption = req.body.sendOption === 'schedule' ? 'schedule' : 'now';
  const scheduledAt = (req.body.scheduledAt || '').trim();

  if (recipientIds.length === 0 || !subject || !body) {
    return res.render('admin-email-compose', {
      title: 'Compose Email',
      recipients: [],
      error: 'Recipients, a subject, and a message are all required. Go back and try again.',
    });
  }
  if (sendOption === 'schedule' && !scheduledAt) {
    const candidates = await emailComposer.listRecipientCandidates();
    return res.render('admin-email-compose', {
      title: 'Compose Email',
      recipients: candidates.filter((c) => recipientIds.includes(c.accountId)),
      error: 'Choose a date/time to schedule this email for.',
    });
  }

  if (sendOption === 'schedule') {
    await emailComposer.createScheduled({ subject, bodyHtml: body, replyTo, recipientAccountIds: recipientIds, scheduledAt, sentByAccountId: null, sentByPortal: 'coop_admin' });
    return res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await emailComposer.createAndSend({ subject, bodyHtml: body, replyTo, recipientAccountIds: recipientIds, sentByAccountId: null, sentByPortal: 'coop_admin' });
  res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/announcements/email/:id/send', requireAdmin, async (req, res) => {
  const campaign = await emailComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/admin/announcements/email?error=' + encodeURIComponent('That email was already sent or does not exist.'));
  res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Text composer tab (item 13) isn't built yet - keeps the 4-tab
// Communication bar fully clickable in the meantime rather than linking
// to a 404.
router.get('/announcements/text', requireAdmin, (req, res) => {
  res.render('admin-communication-coming-soon', { title: 'Communication', activeTab: 'text' });
});

module.exports = router;
