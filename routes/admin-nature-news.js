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
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_publications'));

router.get('/', async (req, res) => {
  const pending = await natureNews.listPending();
  // Was hard-capped at 20 (listApproved(20)) - same truncation problem
  // every other ongoing list/log in the portal had, fixed the same way
  // (utils/pagination.js's in-memory paginate(), not a second,
  // differently-shaped SQL query).
  const allApproved = await natureNews.listApproved();
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allApproved, parsePage(req.query.page), pageSize);
  res.render('admin-nature-news', {
    title: 'Nature News',
    pending,
    approved: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: '/main-admin/nature-news?',
    notice: req.query.notice || null,
  });
});

router.post('/:id/decide', async (req, res) => {
  await natureNews.decide(req.params.id, req.body.decision === 'approve', req.portalAccount.id);
  res.redirect('/main-admin/nature-news?notice=' + encodeURIComponent(req.body.decision === 'approve' ? 'Post approved.' : 'Post rejected.'));
});

module.exports = router;
