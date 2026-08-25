// Main Admin's Member Directory settings (Community & Commerce track,
// item 5) - mounted at /main-admin/member-directory (server.js). There's
// no listing CRUD here (unlike admin-directory.js/admin-classifieds.js) -
// the directory reads live from the existing members table, so the only
// thing to manage is which fields are exposed at all. Gated by
// manage_directory, the same permission that already covers the
// business directory (its own catalog description: "Manage the member
// and business directories").
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const memberDirectory = require('../utils/memberDirectory');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_directory'));

router.get('/', async (req, res) => {
  const fieldSettings = await memberDirectory.getFieldSettings();
  const members = await memberDirectory.listDirectoryMembers();
  res.render('admin-member-directory', { title: 'Member Directory', fieldSettings, memberCount: members.length, notice: req.query.notice || null });
});

router.post('/fields', async (req, res) => {
  const visibleKeys = [].concat(req.body.fields || []);
  await memberDirectory.setFieldVisibility(visibleKeys);
  res.redirect('/main-admin/member-directory?notice=' + encodeURIComponent('Saved.'));
});

module.exports = router;
