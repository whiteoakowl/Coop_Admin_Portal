// Member/public-facing Committees - a real request: "add a button on the
// parent portal homepage for committee sign up, click the button and
// they can fill out a form and choose committee positions to help
// with." Mounted at /committees (server.js), same "any signed-in portal
// account, not scoped to one portal" shape as routes/events.js's own
// volunteer-role signup.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const volunteers = require('../utils/committeesAndSignupLists');

router.get('/', requirePortalAuth, async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const family = await familyForAccount(req.portalAccount.id);
  const familyIds = family.map((m) => m.id);
  const committees = (await volunteers.listCommittees()).filter((c) => c.enabled);
  for (const committee of committees) {
    committee.positions = await volunteers.positionsForCommittee(committee.id);
  }
  res.render('committees', {
    title: 'Committee Sign Up',
    settings,
    committees,
    family,
    familyIds,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:positionId/signup', requirePortalAuth, async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect('/committees?error=' + encodeURIComponent('You can only sign up your own family.'));
  }
  await volunteers.signUpForPosition(req.params.positionId, memberId, req.portalAccount.id);
  res.redirect('/committees?notice=' + encodeURIComponent('Signed up - thank you for volunteering!'));
});

router.post('/:positionId/cancel', requirePortalAuth, async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect('/committees?error=' + encodeURIComponent('You can only manage your own family\'s signups.'));
  }
  await volunteers.cancelCommitteeSignup(req.params.positionId, memberId);
  res.redirect('/committees?notice=' + encodeURIComponent('Signup cancelled.'));
});

module.exports = router;
