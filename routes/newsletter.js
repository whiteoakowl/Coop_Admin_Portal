// Member-facing Newsletter archive (Community & Commerce track, item 10),
// mounted at /newsletter (server.js). Members-only, any signed-in portal
// account. There is no real outbound email - see utils/newsletter.js's
// own header comment - so this in-app archive of status='sent' issues is
// the actual substitute for "the newsletter members received". Draft and
// scheduled issues are never queried here, so an unsent issue can't be
// reached even by guessing its id.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const newsletter = require('../utils/newsletter');

router.use(requirePortalAuth);

// A real request: "the newsletter being sent out is controlled by the
// newsletter schedule settings already built on the page" - checked here
// too (not just the admin editor's own GET /), so the current issue
// still goes out on schedule even on a week nobody visits /main-admin/
// newsletter before a member checks this archive themselves.
router.get('/', async (req, res) => {
  await newsletter.advanceIfDue();
  const issues = await db.prepare("SELECT * FROM newsletter_issues WHERE status = 'sent' ORDER BY sent_at DESC").all();
  res.render('newsletter-list', { title: 'Newsletter', issues });
});

router.get('/:id', async (req, res) => {
  await newsletter.advanceIfDue();
  const issue = await db.prepare("SELECT * FROM newsletter_issues WHERE id = ? AND status = 'sent'").get(req.params.id);
  if (!issue) return res.status(404).render('404', { title: 'Not Found' });
  res.render('newsletter-detail', { title: issue.subject, issue });
});

module.exports = router;
