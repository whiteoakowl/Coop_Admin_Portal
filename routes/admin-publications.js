// Main Admin's Publications/Articles management (Community & Commerce
// track, item 12) - mounted at /main-admin/publications, gated by
// manage_publications. Editing reuses Forums' own rich-text editor and
// server-side sanitizer (utils/sanitizeHtml.js's sanitizePostBody(),
// called from utils/publications.js's updatePublication()) rather than
// inventing a parallel one.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const publications = require('../utils/publications');
const auditLog = require('../utils/auditLog');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_publications'));

router.get('/', async (req, res) => {
  // Full, unbounded publications list - never large enough to be a query
  // bottleneck (see utils/pagination.js's own header comment), but
  // unpaginated this rendered years of articles as one giant table.
  const allItems = await publications.listPublications();
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allItems, parsePage(req.query.page), pageSize);
  res.render('admin-publications-list', {
    title: 'Publications',
    items: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: '/main-admin/publications?',
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/publications?notice=' + encodeURIComponent('A title is required.'));
  const id = await publications.createDraft(title, req.portalAccount.id);
  res.redirect(`/main-admin/publications/${id}/edit`);
});

async function loadEditor(req, res) {
  const item = await publications.getPublication(req.params.id);
  if (!item) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-publications-edit', { title: item.title, item, error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/main-admin/publications/${id}/edit?error=` + encodeURIComponent('A title is required.'));
  await publications.updatePublication(id, { title, bodyHtml: req.body.bodyHtml || '', visibility: req.body.visibility });
  res.redirect(`/main-admin/publications/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/publish', async (req, res) => {
  await publications.publish(req.params.id);
  res.redirect(`/main-admin/publications/${req.params.id}/edit?notice=` + encodeURIComponent('Published.'));
});

router.post('/:id/unpublish', async (req, res) => {
  await publications.unpublish(req.params.id);
  res.redirect(`/main-admin/publications/${req.params.id}/edit?notice=` + encodeURIComponent('Moved back to draft.'));
});

router.post('/:id/delete', async (req, res) => {
  const item = await publications.getPublication(req.params.id);
  await publications.deletePublication(req.params.id);
  await auditLog.record(req.portalAccount.id, 'publication_deleted', 'publication', req.params.id, item?.title);
  res.redirect('/main-admin/publications?notice=' + encodeURIComponent('Deleted.'));
});

module.exports = router;
