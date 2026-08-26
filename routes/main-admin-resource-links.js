// Main Admin > Resource Links - a short, curated list of external links
// (a Google Classroom folder, a reading list, a permission-slip form,
// etc.) shown on member portals, currently just Student Portal's
// "Resource Links" tab (routes/student-portal.js). Optionally scoped to
// one role via roleKey, the same null-means-everyone convention Main
// Admin's own Announcements screen already uses for "Send to" - see
// routes/main-admin-announcements.js.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const resourceLinks = require('../utils/resourceLinks');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_resources'));

router.get('/', async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const links = await resourceLinks.listAllResourceLinks();
  res.render('main-admin-resource-links', {
    title: 'Resource Links',
    roles,
    links,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  const description = (req.body.description || '').trim();
  const roleKey = (req.body.roleKey || '').trim();
  if (!title || !url) return res.redirect('/main-admin/resource-links?error=' + encodeURIComponent('Title and URL are required.'));

  await resourceLinks.createResourceLink({ title, url, description, roleKey, createdByAccountId: req.portalAccount.id });
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent('Link added.'));
});

router.post('/:id/delete', async (req, res) => {
  await resourceLinks.deleteResourceLink(parseInt(req.params.id, 10));
  res.redirect('/main-admin/resource-links?notice=' + encodeURIComponent('Link removed.'));
});

module.exports = router;
