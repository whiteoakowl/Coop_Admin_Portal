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
const emailComposer = require('../utils/emailComposer');
const textComposer = require('../utils/textComposer');

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

// Communication > Email tab (item 12): filter popup + checkbox member
// list, "Create Email" -> compose screen, send now or schedule for
// later. See utils/emailComposer.js's own header comment for why
// filtering happens in JS against the candidates list rather than in SQL.
router.get('/email', async (req, res) => {
  const [roles, sections, gradeLevels, candidates, campaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    emailComposer.listCampaigns(),
  ]);
  res.render('main-admin-email', {
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

router.post('/email/compose', async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (recipientIds.length === 0) return res.redirect('/main-admin/announcements/email?error=' + encodeURIComponent('Select at least one recipient.'));

  const candidates = await emailComposer.listRecipientCandidates();
  const recipients = candidates.filter((c) => recipientIds.includes(c.accountId));
  res.render('main-admin-email-compose', {
    title: 'Compose Email',
    recipients,
    error: null,
  });
});

router.post('/email/send', async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const subject = (req.body.subject || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  const replyTo = (req.body.replyTo || '').trim();
  const sendOption = req.body.sendOption === 'schedule' ? 'schedule' : 'now';
  const scheduledAt = (req.body.scheduledAt || '').trim();

  if (recipientIds.length === 0 || !subject || !body) {
    return res.render('main-admin-email-compose', {
      title: 'Compose Email',
      recipients: [],
      error: 'Recipients, a subject, and a message are all required. Go back and try again.',
    });
  }
  if (sendOption === 'schedule' && !scheduledAt) {
    const candidates = await emailComposer.listRecipientCandidates();
    return res.render('main-admin-email-compose', {
      title: 'Compose Email',
      recipients: candidates.filter((c) => recipientIds.includes(c.accountId)),
      error: 'Choose a date/time to schedule this email for.',
    });
  }

  if (sendOption === 'schedule') {
    await emailComposer.createScheduled({ subject, bodyHtml: body, replyTo, recipientAccountIds: recipientIds, scheduledAt, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
    return res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await emailComposer.createAndSend({ subject, bodyHtml: body, replyTo, recipientAccountIds: recipientIds, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/email/:id/send', async (req, res) => {
  const campaign = await emailComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/email?error=' + encodeURIComponent('That email was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Communication > Text tab (item 13): same filtered member list as
// Email (utils/emailComposer.js's own listRecipientCandidates()), a
// simpler compose screen (plain 50-word-capped textbox, no subject, no
// rich text, no reply-to), send now or schedule for later.
router.get('/text', async (req, res) => {
  const [roles, sections, gradeLevels, candidates, campaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    textComposer.listCampaigns(),
  ]);
  res.render('main-admin-text', {
    title: 'Communication',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    campaigns,
    maxWords: textComposer.MAX_WORDS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/text/compose', async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (recipientIds.length === 0) return res.redirect('/main-admin/announcements/text?error=' + encodeURIComponent('Select at least one recipient.'));

  const candidates = await emailComposer.listRecipientCandidates();
  const recipients = candidates.filter((c) => recipientIds.includes(c.accountId));
  res.render('main-admin-text-compose', {
    title: 'Compose Text',
    recipients,
    maxWords: textComposer.MAX_WORDS,
    error: null,
  });
});

router.post('/text/send', async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const body = (req.body.body || '').trim();
  const sendOption = req.body.sendOption === 'schedule' ? 'schedule' : 'now';
  const scheduledAt = (req.body.scheduledAt || '').trim();
  const wordCount = textComposer.wordCount(body);

  const renderError = async (message) => {
    const candidates = await emailComposer.listRecipientCandidates();
    return res.render('main-admin-text-compose', {
      title: 'Compose Text',
      recipients: candidates.filter((c) => recipientIds.includes(c.accountId)),
      maxWords: textComposer.MAX_WORDS,
      error: message,
    });
  };

  if (recipientIds.length === 0 || !body) return renderError('Recipients and a message are both required. Go back and try again.');
  if (wordCount > textComposer.MAX_WORDS) return renderError(`That message is ${wordCount} words - texts are capped at ${textComposer.MAX_WORDS} words.`);
  if (sendOption === 'schedule' && !scheduledAt) return renderError('Choose a date/time to schedule this text for.');

  if (sendOption === 'schedule') {
    await textComposer.createScheduled({ body, recipientAccountIds: recipientIds, scheduledAt, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
    return res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await textComposer.createAndSend({ body, recipientAccountIds: recipientIds, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/text/:id/send', async (req, res) => {
  const campaign = await textComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/text?error=' + encodeURIComponent('That text was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

module.exports = router;
