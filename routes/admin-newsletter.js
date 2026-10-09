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

// A real request: "there should only be one newsletter to edit. remove
// the table and add new issue buttons and features. when you click on
// the newsletter subpage it should have all the editing features and
// newsletter textbox on that page." newsletter_issues keeps its own
// history of every past 'sent' issue (the member-facing archive -
// routes/newsletter.js/newsletter-list.ejs - still browses all of them),
// but the admin side now always operates on exactly one current
// draft/scheduled issue instead of picking one from a list: whichever
// mostRecentUnsentIssue() already finds, auto-creating a fresh one the
// moment none exists (a brand new co-op, or right after the current one
// gets marked sent) so this page is never empty and never asks for a
// subject up front.
const DEFAULT_NEWSLETTER_SUBJECT = 'This Week at the Co-op';

async function currentIssue(req) {
  let issue = await newsletter.mostRecentUnsentIssue();
  if (!issue) {
    const id = await newsletter.createDraft(DEFAULT_NEWSLETTER_SUBJECT, req.portalAccount.id);
    issue = await newsletter.getIssue(id);
  }
  return issue;
}

router.get('/', async (req, res) => {
  res.render('admin-newsletter-edit', {
    title: 'Newsletter',
    issue: await currentIssue(req),
    schedule: await loadSendSchedule(),
    weekdays: WEEKDAYS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Stale bookmarks/links to the old per-issue edit URL land back on the
// one true page instead of a 404.
router.get('/:id/edit', (req, res) => res.redirect('/main-admin/newsletter'));

// A real request: "check box under send automatically every week for
// send newsletter immediately for a quick one time send out off
// schedule. Reverts back to schedule settings after." The schedule
// fields (day/time/enabled) always save exactly as submitted, same as
// before - sendNow is a one-time action layered on top, never itself
// persisted, so the checkbox is always unchecked again on reload
// regardless of whether a send just happened.
router.post('/settings', async (req, res) => {
  const day = WEEKDAYS.includes(req.body.day) ? req.body.day : 'Monday';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.time || '') ? req.body.time : '08:00';
  await setAppSetting(NEWSLETTER_SEND_DAY_KEY, day);
  await setAppSetting(NEWSLETTER_SEND_TIME_KEY, time);
  await setAppSetting(NEWSLETTER_SEND_ENABLED_KEY, req.body.enabled === '1' ? '1' : '0');

  if (req.body.sendNow === '1') {
    const issue = await newsletter.mostRecentUnsentIssue();
    if (!issue) return res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Schedule saved. Nothing to send immediately - create an issue first.'));
    await newsletter.markSent(issue.id);
    return res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent(`Schedule saved. "${issue.subject}" sent immediately.`));
  }

  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Send schedule saved.'));
});

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const subject = (req.body.subject || '').trim();
  if (!subject) return res.redirect('/main-admin/newsletter?error=' + encodeURIComponent('A subject is required.'));
  await newsletter.updateIssue(id, { subject, customNote: req.body.customNote || '' });
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Saved.'));
});

// A real request: "add a button for view newsletter." Reuses the exact
// same member-facing template (views/newsletter-detail.ejs, normally only
// reachable once status='sent' - see routes/newsletter.js's own comment)
// so an admin can see precisely what a draft or scheduled issue will look
// like before it ever sends, not just the plain contenteditable divs this
// edit page itself shows.
router.get('/:id/preview', async (req, res) => {
  const issue = await newsletter.getIssue(req.params.id);
  if (!issue) return res.status(404).render('404', { title: 'Not Found' });
  res.render('newsletter-detail', {
    title: issue.subject,
    issue,
    portalTitle: 'Main Admin',
    backHref: '/main-admin/newsletter',
  });
});

router.post('/:id/schedule', async (req, res) => {
  const scheduledAt = (req.body.scheduledAt || '').trim();
  if (!scheduledAt) return res.redirect('/main-admin/newsletter?error=' + encodeURIComponent('Choose a date/time to schedule.'));
  await newsletter.scheduleIssue(req.params.id, scheduledAt);
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Scheduled.'));
});

router.post('/:id/unschedule', async (req, res) => {
  await newsletter.unschedule(req.params.id);
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Moved back to draft.'));
});

// Marking the current issue sent leaves currentIssue() with nothing
// non-sent to find on the next GET /, so it auto-creates the next one -
// "only one newsletter to edit" holds on every visit, not just the first.
router.post('/:id/send', async (req, res) => {
  await newsletter.markSent(req.params.id);
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Marked sent.'));
});

// Same auto-create-on-next-visit reasoning as send above - deleting the
// current draft just means currentIssue() builds a fresh one next time.
router.post('/:id/delete', async (req, res) => {
  const issue = await newsletter.getIssue(req.params.id);
  await newsletter.deleteIssue(req.params.id);
  await auditLog.record(req.portalAccount.id, 'newsletter_issue_deleted', 'newsletter_issue', req.params.id, issue?.subject);
  res.redirect('/main-admin/newsletter?notice=' + encodeURIComponent('Issue deleted.'));
});

module.exports = router;
