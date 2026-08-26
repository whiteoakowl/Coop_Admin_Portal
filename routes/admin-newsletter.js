// Main Admin's Weekly Newsletter management (Community & Commerce track,
// item 10) - mounted at /main-admin/newsletter (server.js), gated the
// same way every other Track B admin section is (manage_communications,
// added to db/bootstrapPg.js's PORTAL_PERMISSIONS for this feature).
// Business logic (assembly, sanitizing, status transitions) all lives in
// utils/newsletter.js - this router is just the CRUD/HTTP layer over it.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const newsletter = require('../utils/newsletter');
const auditLog = require('../utils/auditLog');
const { appSetting, setAppSetting } = require('../utils/classSchedule');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_communications'));

// When the weekly newsletter would go out, if automated sending is ever
// wired up (see utils/emailProvider.js's own header comment on why no
// real provider is configured yet - a real request: "there should be
// setting for when the email is sent and when its turned off," built now
// as the schedule/toggle Main Admin controls, even though nothing reads
// it to actually trigger a send yet). Stored in app_settings (the same
// generic key/value table utils/classSchedule.js's own appSetting/
// setAppSetting already read/write for other single-row settings), not a
// dedicated table - three scalar values, one row, no history needed.
const NEWSLETTER_SEND_DAY_KEY = 'newsletter_send_day';
const NEWSLETTER_SEND_TIME_KEY = 'newsletter_send_time';
const NEWSLETTER_SEND_ENABLED_KEY = 'newsletter_send_enabled';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadSendSchedule() {
  return {
    day: await appSetting(NEWSLETTER_SEND_DAY_KEY, 'Monday'),
    time: await appSetting(NEWSLETTER_SEND_TIME_KEY, '08:00'),
    enabled: (await appSetting(NEWSLETTER_SEND_ENABLED_KEY, '0')) === '1',
  };
}

router.get('/', async (req, res) => {
  const issues = await newsletter.listIssues();
  res.render('admin-newsletter-list', {
    title: 'Newsletter',
    issues,
    schedule: await loadSendSchedule(),
    weekdays: WEEKDAYS,
    notice: req.query.notice || null,
  });
});

router.post('/settings', async (req, res) => {
  const day = WEEKDAYS.includes(req.body.day) ? req.body.day : 'Monday';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.time || '') ? req.body.time : '08:00';
  await setAppSetting(NEWSLETTER_SEND_DAY_KEY, day);
  await setAppSetting(NEWSLETTER_SEND_TIME_KEY, time);
  await setAppSetting(NEWSLETTER_SEND_ENABLED_KEY, req.body.enabled === '1' ? '1' : '0');
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Send schedule saved.'));
});

router.post('/', async (req, res) => {
  const subject = (req.body.subject || '').trim();
  if (!subject) return res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('A subject is required.'));
  const id = await newsletter.createDraft(subject, req.portalAccount.id);
  res.redirect(`/main-admin/newsletter/${id}/edit`);
});

async function loadEditor(req, res) {
  const issue = await newsletter.getIssue(req.params.id);
  if (!issue) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-newsletter-edit', { title: issue.subject, issue, error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const subject = (req.body.subject || '').trim();
  if (!subject) return res.redirect(`/main-admin/newsletter/${id}/edit?error=` + encodeURIComponent('A subject is required.'));
  await newsletter.updateIssue(id, { subject, bodyHtml: req.body.bodyHtml || '' });
  res.redirect(`/main-admin/newsletter/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/regenerate', async (req, res) => {
  await newsletter.regenerate(req.params.id);
  res.redirect(`/main-admin/newsletter/${req.params.id}/edit?notice=` + encodeURIComponent('Re-assembled from live data.'));
});

router.post('/:id/schedule', async (req, res) => {
  const scheduledAt = (req.body.scheduledAt || '').trim();
  if (!scheduledAt) return res.redirect(`/main-admin/newsletter/${req.params.id}/edit?error=` + encodeURIComponent('Choose a date/time to schedule.'));
  await newsletter.scheduleIssue(req.params.id, scheduledAt);
  res.redirect(`/main-admin/newsletter/${req.params.id}/edit?notice=` + encodeURIComponent('Scheduled.'));
});

router.post('/:id/unschedule', async (req, res) => {
  await newsletter.unschedule(req.params.id);
  res.redirect(`/main-admin/newsletter/${req.params.id}/edit?notice=` + encodeURIComponent('Moved back to draft.'));
});

router.post('/:id/send', async (req, res) => {
  await newsletter.markSent(req.params.id);
  res.redirect(`/main-admin/newsletter/${req.params.id}/edit?notice=` + encodeURIComponent('Marked sent.'));
});

router.post('/:id/delete', async (req, res) => {
  const issue = await newsletter.getIssue(req.params.id);
  await newsletter.deleteIssue(req.params.id);
  await auditLog.record(req.portalAccount.id, 'newsletter_issue_deleted', 'newsletter_issue', req.params.id, issue?.subject);
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Issue deleted.'));
});

module.exports = router;
