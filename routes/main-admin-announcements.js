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
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('send_announcements'));

router.get('/', async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const roleLabelByKey = Object.fromEntries(roles.map((r) => [r.key, r.label]));
  // limit: null - every announcement ever sent/scheduled, not just the
  // most recent 25 - paginate() below slices it at render time instead
  // (see utils/pagination.js's own header comment).
  const allLog = await announcements.listAnnouncementLog(null);
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allLog, parsePage(req.query.page), pageSize);
  res.render('main-admin-announcements', {
    title: 'Communication',
    roles,
    log: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: '/main-admin/announcements?',
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

  // A real request: "send announcement should say send announcements
  // now. Button next to it should say schedule for later. That button
  // allows you to pick a date and time to send."
  const scheduledAt = (req.body.scheduledAt || '').trim();
  if (scheduledAt) {
    await announcements.scheduleAnnouncement({ title, body, targets, scheduledAt, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
    return res.redirect('/main-admin/announcements?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await announcements.sendAnnouncement({
    title,
    body,
    targets,
    sentByAccountId: req.portalAccount.id,
    sentByPortal: 'main_admin',
  });

  res.redirect('/main-admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

// A real request: "Communication tab. There is a sub page for text and
// a subpage for email. Combine them and call it Text/Email. This page
// will have three buttons at the top. Filter, send text, send email.
// When you click on each of these buttons it goes to a new page where
// you can complete the tasks and write the message." Email and Text's
// own GET pages (just below) now redirect here - their old embedded
// filter dialog + candidate table moved out to its own /text-email/filter
// page (req.session.textEmailRecipientIds carries the selection across),
// and Send Text/Send Email jump straight to the existing compose screens
// using whatever that session holds (or every active candidate, if
// nothing has been filtered yet - Send Text/Send Email are never a dead
// end waiting on Filter).
router.get('/text-email', async (req, res) => {
  const recipientIds = req.session.textEmailRecipientIds || [];
  const [emailCampaigns, textCampaigns] = await Promise.all([emailComposer.listCampaigns(), textComposer.listCampaigns()]);
  res.render('main-admin-text-email', {
    title: 'Communication',
    recipientCount: recipientIds.length,
    emailCampaigns,
    textCampaigns,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/text-email/filter', async (req, res) => {
  const [roles, sections, gradeLevels, candidates] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
  ]);
  const selectedIds = new Set(req.session.textEmailRecipientIds || []);
  res.render('main-admin-text-email-filter', {
    title: 'Filter Recipients',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    selectedIds,
  });
});

router.post('/text-email/filter', (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  req.session.textEmailRecipientIds = recipientIds;
  const notice = recipientIds.length === 0 ? 'Filter cleared - Send Text/Send Email will reach every active member.' : `${recipientIds.length} recipient(s) selected.`;
  res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(notice));
});

async function resolveFilteredOrAllRecipients(req) {
  const recipientIds = req.session.textEmailRecipientIds || [];
  if (recipientIds.length > 0) return emailComposer.resolveRecipients({ recipientIds });
  return emailComposer.listRecipientCandidates();
}

router.get('/text-email/send-text', async (req, res) => {
  const recipients = await resolveFilteredOrAllRecipients(req);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('No active members to text.'));
  res.render('main-admin-text-compose', { title: 'Compose Text', recipients, maxWords: textComposer.MAX_WORDS, error: null });
});

router.get('/text-email/send-email', async (req, res) => {
  const recipients = await resolveFilteredOrAllRecipients(req);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('No active members to email.'));
  res.render('main-admin-email-compose', { title: 'Compose Email', recipients, error: null });
});

// Communication > Email tab (item 12): now a redirect to the combined
// Text/Email page above - kept as its own route so an old bookmark/link
// still lands somewhere real. See utils/emailComposer.js's own header
// comment for why filtering happens in JS against the candidates list
// rather than in SQL.
router.get('/email', (req, res) => res.redirect('/main-admin/announcements/text-email'));

// recipientIds (Email/Text tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Email" - see emailComposer.js's
// own resolveRecipients() comment) - either lands here.
router.post('/email/compose', async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('Select at least one recipient.'));
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
  const sendTo = (req.body.sendTo || '').trim();
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
    await emailComposer.createScheduled({ subject, bodyHtml: body, replyTo, sendTo, recipientAccountIds: recipientIds, scheduledAt, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
    return res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await emailComposer.createAndSend({ subject, bodyHtml: body, replyTo, sendTo, recipientAccountIds: recipientIds, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/email/:id/send', async (req, res) => {
  const campaign = await emailComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('That email was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Communication > Text tab (item 13): now a redirect to the combined
// Text/Email page above, same as Email's own redirect.
router.get('/text', (req, res) => res.redirect('/main-admin/announcements/text-email'));

// recipientIds (Email/Text tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Text" - see emailComposer.js's own
// resolveRecipients() comment) - either lands here.
router.post('/text/compose', async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('Select at least one recipient.'));
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
    return res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await textComposer.createAndSend({ body, recipientAccountIds: recipientIds, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/text/:id/send', async (req, res) => {
  const campaign = await textComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/text-email?error=' + encodeURIComponent('That text was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/text-email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Must come last - /:id matches a single path segment just like every
// literal /email.../text... route above (Express tries routes in
// registration order), so registering this first would have caught
// POST /email/send etc. with id="email" before they ever reached their
// own handlers. Same ordering requirement documented in routes/main-
// admin-resource-links.js/routes/admin-directory.js.
router.post('/:id/send', async (req, res) => {
  const result = await announcements.sendScheduledAnnouncement(req.params.id);
  if (!result) return res.redirect('/main-admin/announcements?error=' + encodeURIComponent('That announcement was already sent or does not exist.'));
  res.redirect('/main-admin/announcements?notice=' + encodeURIComponent(`Sent to ${result.recipientCount} member(s).`));
});

module.exports = router;
