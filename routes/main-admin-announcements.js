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
const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const announcements = require('../utils/announcements');
const emailComposer = require('../utils/emailComposer');
const textComposer = require('../utils/textComposer');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { formatFriendlyTimestamp } = require('../utils/dates');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient } = require('../utils/storage');
const { saveUpload, urlForUpload } = require('../utils/uploadBackend');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('send_announcements'));

// A real request: "Click send text button... It should have an option
// to upload a photo." Same optional-MMS-image upload pattern routes/
// admin-announcements.js's own copy of this route uses, just its own
// bucket/dir (same convention as routes/main-admin-members.js duplicating
// routes/admin-members.js's own member-text-images bucket).
const MAX_TEXT_CAMPAIGN_IMAGE_BYTES = 5 * 1024 * 1024;
const TEXT_CAMPAIGN_IMAGE_BUCKET = 'text-campaign-images';
const TEXT_CAMPAIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'text-campaign-images');
if (!createStorageClient() && !fs.existsSync(TEXT_CAMPAIGN_IMAGE_DIR)) {
  try {
    fs.mkdirSync(TEXT_CAMPAIGN_IMAGE_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${TEXT_CAMPAIGN_IMAGE_DIR}:`, err.message);
  }
}
const textCampaignImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TEXT_CAMPAIGN_IMAGE_BYTES }, fileFilter: imageFileFilter });

// Builds the Past & Scheduled list's own display fields (partials/
// communication-campaign-list.ejs) server-side - "fix date and time
// format to match the rest of the site. This should be hard coded
// somewhere so it's always coded this way" - utils/dates.js's own
// formatFriendlyTimestamp() is that one shared place, the same
// formatter already used across the rest of the app, instead of
// printing the raw now_text()/scheduled_at string.
function formatCampaignForList(c, { titleField, sendNowAction }) {
  return {
    ...c,
    titleText: c[titleField],
    statusLabel: c.status.charAt(0).toUpperCase() + c.status.slice(1),
    dateTimeLabel: c.status === 'sent' ? formatFriendlyTimestamp(c.sent_at) : `Scheduled for ${formatFriendlyTimestamp(c.scheduled_at)}`,
    sendNowAction,
  };
}

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

// Communication > Email tab (item 12): a real request: "Communication.
// Text/email. Page should show a list of all members. Then filter
// button narrows it down in a popup screen." The full candidate
// checkbox list lives directly on this page now (every row starts
// checked - Create Email/Send Email reaches everyone by default), with
// Filter just a <dialog> over the same role/section/grade/age/
// registered narrowing partials/communication-recipient-picker.ejs's
// own client-side JS already did when it lived on its own separate
// /text-email/filter page. See routes/admin-announcements.js's
// identical tab for the Co-op Admin side.
router.get('/email', async (req, res) => {
  const [roles, sections, gradeLevels, candidates, emailCampaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    emailComposer.listCampaigns(),
  ]);
  res.render('main-admin-email', {
    title: 'Email',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    emailCampaigns: emailCampaigns.map((c) => formatCampaignForList(c, { titleField: 'subject', sendNowAction: `/main-admin/announcements/email/${c.id}/send` })),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// recipientIds (Email tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Email" - see emailComposer.js's
// own resolveRecipients() comment) - either lands here.
router.post('/email/compose', async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/email?error=' + encodeURIComponent('Select at least one recipient.'));
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
    return res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await emailComposer.createAndSend({ subject, bodyHtml: body, replyTo, sendTo, recipientAccountIds: recipientIds, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/email/:id/send', async (req, res) => {
  const campaign = await emailComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/email?error=' + encodeURIComponent('That email was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Communication > Text tab (item 13): same "full member list + Filter
// popup" page shape as Email above, just text_campaigns/textComposer
// instead of email_campaigns/emailComposer - "separate text and email
// subpages again. Because they have their own past messages list at the
// bottom of the page."
router.get('/text', async (req, res) => {
  const [roles, sections, gradeLevels, candidates, textCampaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    textComposer.listCampaigns(),
  ]);
  res.render('main-admin-text', {
    title: 'Text',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    textCampaigns: textCampaigns.map((c) => formatCampaignForList(c, { titleField: 'body', sendNowAction: `/main-admin/announcements/text/${c.id}/send` })),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// recipientIds (Text tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Text" - see emailComposer.js's own
// resolveRecipients() comment) - either lands here.
router.post('/text/compose', async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/main-admin/announcements/text?error=' + encodeURIComponent('Select at least one recipient.'));
  res.render('main-admin-text-compose', {
    title: 'Compose Text',
    recipients,
    maxLength: textComposer.MAX_SMS_LENGTH,
    error: null,
  });
});

router.post('/text/send', textCampaignImageUpload.single('image'), async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const body = (req.body.body || '').trim();
  const sendOption = req.body.sendOption === 'schedule' ? 'schedule' : 'now';
  const scheduledAt = (req.body.scheduledAt || '').trim();

  const renderError = async (message) => {
    const candidates = await emailComposer.listRecipientCandidates();
    return res.render('main-admin-text-compose', {
      title: 'Compose Text',
      recipients: candidates.filter((c) => recipientIds.includes(c.accountId)),
      maxLength: textComposer.MAX_SMS_LENGTH,
      error: message,
    });
  };

  if (recipientIds.length === 0 || !body) return renderError('Recipients and a message are both required. Go back and try again.');
  // A real request: "Set 160 character length for all texting features
  // across the app."
  if (body.length > textComposer.MAX_SMS_LENGTH) return renderError(`That message is ${body.length} characters - texts are capped at ${textComposer.MAX_SMS_LENGTH} characters.`);
  if (sendOption === 'schedule' && !scheduledAt) return renderError('Choose a date/time to schedule this text for.');

  let mediaUrl = null;
  if (req.file) {
    const client = createStorageClient();
    const key = await saveUpload({
      client,
      bucket: TEXT_CAMPAIGN_IMAGE_BUCKET,
      localDir: TEXT_CAMPAIGN_IMAGE_DIR,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
    });
    mediaUrl = urlForUpload({ client, bucket: TEXT_CAMPAIGN_IMAGE_BUCKET, webDir: '/uploads/text-campaign-images', key });
  }

  if (sendOption === 'schedule') {
    await textComposer.createScheduled({ body, recipientAccountIds: recipientIds, mediaUrl, scheduledAt, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
    return res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await textComposer.createAndSend({ body, recipientAccountIds: recipientIds, mediaUrl, sentByAccountId: req.portalAccount.id, sentByPortal: 'main_admin' });
  res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/text/:id/send', async (req, res) => {
  const campaign = await textComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/main-admin/announcements/text?error=' + encodeURIComponent('That text was already sent or does not exist.'));
  res.redirect('/main-admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
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
