// The public marketing homepage - a separate front door for prospective
// and current families, distinct from the kiosk and the operational
// Co-op Admin Portal. Mounted at /welcome, not the site root - a real
// request: "homepage should still be kiosk screen for now" (see server.js's
// own note on that). Read-only for everyone; Main Admin edits the
// underlying site_settings/announcements/faqs rows from /main-admin/website.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { formatFriendlyTimestamp } = require('../utils/dates');
const homepage = require('../utils/homepage');
const { publicShowcaseClasses } = require('../utils/classSchedule');

router.get('/', async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const announcementRows = await db
    .prepare("SELECT * FROM announcements WHERE is_public = 1 AND (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 3")
    .all();
  const announcements = announcementRows.map((a) => ({ ...a, publishedLabel: formatFriendlyTimestamp(a.published_at) }));
  const faqs = await db.prepare('SELECT * FROM faqs WHERE is_public = 1 ORDER BY position, id').all();
  const blocks = await homepage.listBlocks();
  // A real request: "Check box to be viewable to public on public
  // homepage" - a read-only showcase of whichever Schedule Grids an
  // admin has opted into (Edit Schedule Grids popup's own new checkbox).
  // No registration here - a non-member still goes through Member
  // Registration/Login like today, same as every other "Ready to join"
  // CTA on this page.
  // start_time/end_time are free-text labels (e.g. "9:00 AM", typed on
  // the Create Class form), not real SQL timestamps - used as-is rather
  // than run through a timestamp formatter.
  const showcaseClasses = (await publicShowcaseClasses()).map((c) => ({
    ...c,
    timeLabel: c.startTime ? c.startTime + (c.endTime ? ` – ${c.endTime}` : '') : null,
  }));

  res.render('public-home', {
    title: settings.org_name,
    settings,
    announcements,
    faqs,
    blocks,
    showcaseClasses,
  });
});

module.exports = router;
