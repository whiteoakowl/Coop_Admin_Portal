// Main Admin > Resource Links - a curated, categorized list of external
// links (a Google Classroom folder, a reading list, a permission-slip
// form, city/state-specific resources, etc.) shown on member portals,
// currently just Student Portal's "Resource Links" tab (routes/student-
// portal.js). Optionally scoped to one role via roleKey, the same
// null-means-everyone convention Main Admin's own Announcements screen
// already uses for "Send to" - see routes/main-admin-announcements.js.
//
// A real request: "resource links should have add category button on
// admin side. and add resource button. add resource button should pop
// up with a window that asks for city and state, title, description and
// website, category and save. list shows up categorized below. members
// can submit resource links for approval. admin side should have tab
// under resource links for approvals." - the Resources tab below is that
// categorized list + both popups; the Approvals tab is member
// submissions (routes/student-portal.js's own POST /resources/submit)
// awaiting review.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const resourceLinks = require('../utils/resourceLinks');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_resources'));

const TABS = ['resources', 'approvals'];

router.get('/', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'resources';
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  res.render('main-admin-resource-links', {
    title: 'Resource Links',
    activeTab: tab,
    roles,
    categories: await resourceLinks.listCategories(),
    groups: await resourceLinks.listApprovedResourceLinksByCategory(),
    pending: await resourceLinks.listPendingResourceLinks(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  const description = (req.body.description || '').trim();
  const city = (req.body.city || '').trim();
  const state = (req.body.state || '').trim();
  const roleKey = (req.body.roleKey || '').trim();
  const categoryId = parseInt(req.body.categoryId, 10) || null;
  if (!title || !url) return res.redirect('/main-admin/resource-links?error=' + encodeURIComponent('Title and website are required.'));

  await resourceLinks.createResourceLink({ title, url, description, roleKey, city, state, categoryId, createdByAccountId: req.portalAccount.id });
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent('Resource added.'));
});

router.post('/:id/delete', async (req, res) => {
  await resourceLinks.deleteResourceLink(parseInt(req.params.id, 10));
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent('Resource removed.'));
});

router.post('/categories', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/resource-links?error=' + encodeURIComponent('Category name is required.'));
  await resourceLinks.addCategory(title);
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent(`Added "${title}".`));
});

router.post('/categories/:id/delete', async (req, res) => {
  await resourceLinks.deleteCategory(parseInt(req.params.id, 10));
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent('Category removed.'));
});

router.post('/:id/approve', async (req, res) => {
  await resourceLinks.approveResourceLink(parseInt(req.params.id, 10));
  res.redirect('/main-admin/resource-links?tab=approvals&notice=' + encodeURIComponent('Resource approved.'));
});

router.post('/:id/deny', async (req, res) => {
  await resourceLinks.denyResourceLink(parseInt(req.params.id, 10));
  res.redirect('/main-admin/resource-links?tab=approvals&notice=' + encodeURIComponent('Resource denied.'));
});

module.exports = router;
