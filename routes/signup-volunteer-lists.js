// Standalone member-facing pages for a single Sign-Up List or Volunteer
// List (Main Admin's own utils/committeesAndSignupLists.js), reachable on
// their own instead of only embedded inside an attached event's page
// (views/events-detail.ejs already shows the same list inline once it
// carries an event's id). A real request: "add button that says copy
// link... you will have copied the member link to the volunteer or
// signup list to paste somewhere else to share" - before this router,
// neither list type had ANY link of its own to copy, since a list with
// no event attached (event_id is nullable) had no page at all. Mounted
// at the site root (server.js) so the URLs read as plain /signup-
// lists/:id and /volunteer-lists/:id, same "any signed-in portal
// account, not scoped to one portal" shape as routes/committees.js.
const express = require('express');
const router = express.Router();
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const db = require('../db');
const lists = require('../utils/committeesAndSignupLists');

router.get('/signup-lists/:id', requirePortalAuth, async (req, res) => {
  const list = await lists.getSignUpList(req.params.id);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const family = await familyForAccount(req.portalAccount.id);
  res.render('signup-list-detail', {
    title: list.title,
    settings,
    list,
    items: await lists.itemsForSignUpList(list.id),
    family,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/signup-lists/:id/items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const back = `/signup-lists/${req.params.id}`;
  const memberId = parseInt(req.body.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await lists.claimSignUpItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

router.get('/volunteer-lists/:id', requirePortalAuth, async (req, res) => {
  const list = await lists.getVolunteerList(req.params.id);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const family = await familyForAccount(req.portalAccount.id);
  res.render('volunteer-list-detail', {
    title: list.title,
    settings,
    list,
    shifts: await lists.shiftsForVolunteerList(list.id),
    family,
    familyIds: family.map((m) => m.id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteer-lists/:id/shifts/:shiftId/signup', requirePortalAuth, async (req, res) => {
  const back = `/volunteer-lists/${req.params.id}`;
  const memberId = parseInt(req.body.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only sign up yourself or your own family.'));
  }
  await lists.signUpForShift(req.params.shiftId, memberId, req.portalAccount.id);
  res.redirect(back + '?notice=' + encodeURIComponent('Signed up - thank you for volunteering!'));
});

router.post('/volunteer-lists/:id/shifts/:shiftId/cancel', requirePortalAuth, async (req, res) => {
  const back = `/volunteer-lists/${req.params.id}`;
  const memberId = parseInt(req.body.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage your own family\'s signups.'));
  }
  await lists.cancelShiftSignup(req.params.shiftId, memberId);
  res.redirect(back + '?notice=' + encodeURIComponent('Signup cancelled.'));
});

module.exports = router;
