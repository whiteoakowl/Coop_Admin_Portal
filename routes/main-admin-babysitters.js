// Main Admin > Babysitter Directory approval queue - a real request:
// "Requests are sent for approval to main admin." No Co-op Admin
// equivalent (unlike Announcements/Resource Links) - the requester named
// Main Admin specifically as the approver, not "main admin and co-op
// admin" the way item 7 explicitly did.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const babysitters = require('../utils/babysitters');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_babysitters'));

router.get('/', async (req, res) => {
  const profiles = await babysitters.listAllProfiles();
  res.render('main-admin-babysitters', { title: 'Babysitter Directory', profiles, notice: req.query.notice || null });
});

router.post('/:id/approve', async (req, res) => {
  await babysitters.decideSubmission(req.params.id, true);
  res.redirect('/main-admin/babysitters?notice=' + encodeURIComponent('Profile approved.'));
});

router.post('/:id/reject', async (req, res) => {
  await babysitters.decideSubmission(req.params.id, false);
  res.redirect('/main-admin/babysitters?notice=' + encodeURIComponent('Profile rejected.'));
});

module.exports = router;
