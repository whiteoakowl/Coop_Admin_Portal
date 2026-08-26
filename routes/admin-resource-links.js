// Co-op Admin's own Resource Links (mounted at /admin/resource-links,
// server.js) - same underlying utils/resourceLinks.js helpers and
// role-scoping Main Admin's own screen uses (routes/main-admin-resource-
// links.js), just gated behind the Co-op Admin session (requireAdmin)
// instead of a Main Admin portal account - see routes/admin-
// announcements.js's own header comment for why this app carries two
// parallel admin surfaces for member-facing content. createdByAccountId
// stays null here (a Co-op Admin session has no member_accounts row to
// attribute to, unlike a Main Admin portal account) - the column is
// nullable for exactly this reason.
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const resourceLinks = require('../utils/resourceLinks');

router.get('/resource-links', requireAdmin, async (req, res) => {
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  const links = await resourceLinks.listAllResourceLinks();
  res.render('admin-resource-links', {
    title: 'Resource Links',
    roles,
    links,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/resource-links', requireAdmin, async (req, res) => {
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  const description = (req.body.description || '').trim();
  const roleKey = (req.body.roleKey || '').trim();
  if (!title || !url) return res.redirect('/admin/resource-links?error=' + encodeURIComponent('Title and URL are required.'));

  await resourceLinks.createResourceLink({ title, url, description, roleKey, createdByAccountId: null });
  res.redirect('/admin/resource-links?notice=' + encodeURIComponent('Link added.'));
});

router.post('/resource-links/:id/delete', requireAdmin, async (req, res) => {
  await resourceLinks.deleteResourceLink(parseInt(req.params.id, 10));
  res.redirect('/admin/resource-links?notice=' + encodeURIComponent('Link removed.'));
});

module.exports = router;
