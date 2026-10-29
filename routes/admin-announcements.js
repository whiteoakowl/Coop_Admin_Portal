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
const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const announcements = require('../utils/announcements');
const emailComposer = require('../utils/emailComposer');
const textComposer = require('../utils/textComposer');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { formatFriendlyTimestamp } = require('../utils/dates');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient } = require('../utils/storage');
const { saveUpload, urlForUpload } = require('../utils/uploadBackend');

// A real request: "Click send text button... It should have an option
// to upload a photo." Same optional-MMS-image upload pattern routes/
// admin-members.js's own POST /members/:id/text already uses, just its
// own bucket/dir - a private bucket has no fetchable URL for Telnyx's
// own servers to pull the image from, same reasoning that route's own
// comment gives for why theirs is public too.
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

router.get('/announcements', requireAdmin, async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const roleLabelByKey = Object.fromEntries(roles.map((r) => [r.key, r.label]));
  // limit: null - every announcement ever sent/scheduled, not just the
  // most recent 25 - paginate() below slices it at render time instead
  // (see utils/pagination.js's own header comment).
  const allLog = await announcements.listAnnouncementLog(null);
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allLog, parsePage(req.query.page), pageSize);
  res.render('admin-announcements', {
    title: 'Announcements',
    roles,
    log: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: '/admin/announcements?',
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

  // Same "send announcements now / schedule for later" split as Main
  // Admin's own Communication > Announcements tab.
  const scheduledAt = (req.body.scheduledAt || '').trim();
  if (scheduledAt) {
    await announcements.scheduleAnnouncement({ title, body, targets, scheduledAt, sentByAccountId: null, sentByPortal: 'coop_admin' });
    return res.redirect('/admin/announcements?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await announcements.sendAnnouncement({
    title,
    body,
    targets,
    sentByAccountId: null,
    sentByPortal: 'coop_admin',
  });

  res.redirect('/admin/announcements?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

// Communication > Email tab (item 12): a real request: "Communication.
// Text/email. Page should show a list of all members. Then filter
// button narrows it down in a popup screen." The full candidate
// checkbox list lives directly on this page now (every row starts
// checked - Create Email/Send Email reaches everyone by default), with
// Filter just a <dialog> over the same role/section/grade/age/
// registered narrowing partials/communication-recipient-picker.ejs's
// own client-side JS already did when it lived on its own separate
// /text-email/filter page. See routes/main-admin-announcements.js's
// identical tab - same shared utils/emailComposer.js logic, just gated
// behind the Co-op Admin session per this file's own header comment.
router.get('/announcements/email', requireAdmin, async (req, res) => {
  const [roles, sections, gradeLevels, candidates, emailCampaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    emailComposer.listCampaigns(),
  ]);
  res.render('admin-email', {
    title: 'Email',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    emailCampaigns: emailCampaigns.map((c) => formatCampaignForList(c, { titleField: 'subject', sendNowAction: `/admin/announcements/email/${c.id}/send` })),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// recipientIds (Email tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Email" - see emailComposer.js's
// own resolveRecipients() comment) - either lands here.
router.post('/announcements/email/compose', requireAdmin, async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/admin/announcements/email?error=' + encodeURIComponent('Select at least one recipient.'));
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
  const sendTo = (req.body.sendTo || '').trim();
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
    await emailComposer.createScheduled({ subject, bodyHtml: body, replyTo, sendTo, recipientAccountIds: recipientIds, scheduledAt, sentByAccountId: null, sentByPortal: 'coop_admin' });
    return res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await emailComposer.createAndSend({ subject, bodyHtml: body, replyTo, sendTo, recipientAccountIds: recipientIds, sentByAccountId: null, sentByPortal: 'coop_admin' });
  res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/announcements/email/:id/send', requireAdmin, async (req, res) => {
  const campaign = await emailComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/admin/announcements/email?error=' + encodeURIComponent('That email was already sent or does not exist.'));
  res.redirect('/admin/announcements/email?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Communication > Text tab (item 13): same "full member list + Filter
// popup" page shape as Email above, just text_campaigns/textComposer
// instead of email_campaigns/emailComposer - "separate text and email
// subpages again. Because they have their own past messages list at the
// bottom of the page."
router.get('/announcements/text', requireAdmin, async (req, res) => {
  const [roles, sections, gradeLevels, candidates, textCampaigns] = await Promise.all([
    emailComposer.listRoles(),
    emailComposer.listSections(),
    emailComposer.listGradeLevels(),
    emailComposer.listRecipientCandidates(),
    textComposer.listCampaigns(),
  ]);
  res.render('admin-text', {
    title: 'Text',
    roles,
    sections,
    gradeLevels,
    ageGroups: emailComposer.AGE_GROUPS,
    candidates,
    textCampaigns: textCampaigns.map((c) => formatCampaignForList(c, { titleField: 'body', sendNowAction: `/admin/announcements/text/${c.id}/send` })),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// recipientIds (Text tab's own candidate checkboxes) or memberIds
// (Members page's own "Bulk Action > Text" - see emailComposer.js's own
// resolveRecipients() comment) - either lands here.
router.post('/announcements/text/compose', requireAdmin, async (req, res) => {
  const recipients = await emailComposer.resolveRecipients(req.body);
  if (recipients.length === 0) return res.redirect('/admin/announcements/text?error=' + encodeURIComponent('Select at least one recipient.'));
  res.render('admin-text-compose', {
    title: 'Compose Text',
    recipients,
    maxLength: textComposer.MAX_SMS_LENGTH,
    error: null,
  });
});

router.post('/announcements/text/send', requireAdmin, textCampaignImageUpload.single('image'), async (req, res) => {
  const recipientIds = [].concat(req.body.recipientIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const body = (req.body.body || '').trim();
  const sendOption = req.body.sendOption === 'schedule' ? 'schedule' : 'now';
  const scheduledAt = (req.body.scheduledAt || '').trim();

  const renderError = async (message) => {
    const candidates = await emailComposer.listRecipientCandidates();
    return res.render('admin-text-compose', {
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
    await textComposer.createScheduled({ body, recipientAccountIds: recipientIds, mediaUrl, scheduledAt, sentByAccountId: null, sentByPortal: 'coop_admin' });
    return res.redirect('/admin/announcements/text?notice=' + encodeURIComponent(`Scheduled for ${scheduledAt}.`));
  }

  const { recipientCount } = await textComposer.createAndSend({ body, recipientAccountIds: recipientIds, mediaUrl, sentByAccountId: null, sentByPortal: 'coop_admin' });
  res.redirect('/admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${recipientCount} member(s).`));
});

router.post('/announcements/text/:id/send', requireAdmin, async (req, res) => {
  const campaign = await textComposer.sendScheduled(req.params.id);
  if (!campaign) return res.redirect('/admin/announcements/text?error=' + encodeURIComponent('That text was already sent or does not exist.'));
  res.redirect('/admin/announcements/text?notice=' + encodeURIComponent(`Sent to ${campaign.recipient_count} member(s).`));
});

// Must come last - /announcements/:id matches /announcements/email,
// /announcements/text, etc. just like the literal routes above
// (Express tries routes in registration order). Same ordering
// requirement as routes/main-admin-announcements.js's own copy of
// this route.
router.post('/announcements/:id/send', requireAdmin, async (req, res) => {
  const result = await announcements.sendScheduledAnnouncement(req.params.id);
  if (!result) return res.redirect('/admin/announcements?error=' + encodeURIComponent('That announcement was already sent or does not exist.'));
  res.redirect('/admin/announcements?notice=' + encodeURIComponent(`Sent to ${result.recipientCount} member(s).`));
});

module.exports = router;
