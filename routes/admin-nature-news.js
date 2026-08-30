// Main Admin's Nature News review queue - mounted at
// /main-admin/nature-news, gated by manage_publications (reused rather
// than a new dedicated permission - reviewing member-submitted content
// for a homepage feed is the same shape of work that permission already
// covers for photo albums/publications). See utils/natureNews.js's own
// header comment for the pending/approved/rejected shape.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const natureNews = require('../utils/natureNews');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_publications'));

router.get('/', async (req, res) => {
  const pending = await natureNews.listPending();
  const approved = await natureNews.listApproved(20);
  res.render('admin-nature-news', { title: 'Nature News', pending, approved, notice: req.query.notice || null });
});

router.post('/:id/decide', async (req, res) => {
  await natureNews.decide(req.params.id, req.body.decision === 'approve', req.portalAccount.id);
  res.redirect('/main-admin/nature-news?notice=' + encodeURIComponent(req.body.decision === 'approve' ? 'Post approved.' : 'Post rejected.'));
});

module.exports = router;
