// Main Admin's Volunteers section - a real request: "main admin portal,
// volunteer tab, sub pages committees, sign up list, volunteer list."
// See utils/volunteers.js's own header comment for how each of the three
// sub-features is modeled. Reuses the existing (until now unused
// anywhere) manage_volunteers permission - db/bootstrapPg.js already
// described it as "Manage floater/setup-cleanup assignments and event
// volunteer signups," a good fit for this new section too.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const volunteers = require('../utils/committeesAndSignupLists');
const events = require('../utils/events');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_volunteers'));

const TABS = ['committees', 'signup-lists', 'volunteer-lists'];

router.get('/', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'committees';
  res.render('main-admin-volunteers', {
    title: 'Volunteers',
    activeTab: tab,
    committees: tab === 'committees' ? await volunteers.listCommittees() : [],
    signUpLists: tab === 'signup-lists' ? await volunteers.listSignUpLists() : [],
    volunteerLists: tab === 'volunteer-lists' ? await volunteers.listVolunteerLists() : [],
    events: tab === 'signup-lists' || tab === 'volunteer-lists' ? await events.listEvents({}) : [],
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Committees ---

router.post('/committees', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/volunteers?error=' + encodeURIComponent('Committee name is required.'));
  await volunteers.createCommittee({
    name,
    description: (req.body.description || '').trim(),
    leaderName: (req.body.leaderName || '').trim(),
    contactInfo: (req.body.contactInfo || '').trim(),
  });
  res.redirect('/main-admin/volunteers?notice=' + encodeURIComponent('Committee created.'));
});

router.post('/committees/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/main-admin/volunteers/committees/${req.params.id}?error=` + encodeURIComponent('Committee name is required.'));
  await volunteers.updateCommittee(req.params.id, {
    name,
    description: (req.body.description || '').trim(),
    leaderName: (req.body.leaderName || '').trim(),
    contactInfo: (req.body.contactInfo || '').trim(),
  });
  res.redirect('/main-admin/volunteers?notice=' + encodeURIComponent('Committee updated.'));
});

router.post('/committees/:id/enabled', async (req, res) => {
  await volunteers.setCommitteeEnabled(req.params.id, req.body.enabled === '1');
  res.redirect('/main-admin/volunteers?notice=' + encodeURIComponent('Committee updated.'));
});

router.post('/committees/:id/delete', async (req, res) => {
  await volunteers.deleteCommittee(req.params.id);
  res.redirect('/main-admin/volunteers?notice=' + encodeURIComponent('Committee deleted.'));
});

router.get('/committees/:id', async (req, res) => {
  const committee = await volunteers.getCommittee(req.params.id);
  if (!committee) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-committee-detail', {
    title: committee.name,
    committee,
    positions: await volunteers.positionsForCommittee(committee.id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/committees/:id/positions', async (req, res) => {
  const positionName = (req.body.positionName || '').trim();
  if (!positionName) return res.redirect(`/main-admin/volunteers/committees/${req.params.id}?error=` + encodeURIComponent('Position name is required.'));
  await volunteers.addCommitteePosition(req.params.id, { positionName, slotsNeeded: parseInt(req.body.slotsNeeded, 10) || null });
  res.redirect(`/main-admin/volunteers/committees/${req.params.id}?notice=` + encodeURIComponent('Position added.'));
});

router.post('/committees/:id/positions/:positionId/delete', async (req, res) => {
  await volunteers.deleteCommitteePosition(req.params.positionId);
  res.redirect(`/main-admin/volunteers/committees/${req.params.id}?notice=` + encodeURIComponent('Position removed.'));
});

// --- Sign-Up Lists ---

router.post('/signup-lists', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/volunteers?tab=signup-lists&error=' + encodeURIComponent('List title is required.'));
  const id = await volunteers.createSignUpList({
    title,
    description: (req.body.description || '').trim(),
    eventId: req.body.eventId ? parseInt(req.body.eventId, 10) : null,
  });
  res.redirect(`/main-admin/volunteers/signup-lists/${id}?notice=` + encodeURIComponent('List created.'));
});

router.post('/signup-lists/:id/update', async (req, res) => {
  await volunteers.updateSignUpList(req.params.id, {
    title: (req.body.title || '').trim(),
    description: (req.body.description || '').trim(),
    eventId: req.body.eventId ? parseInt(req.body.eventId, 10) : null,
  });
  res.redirect(`/main-admin/volunteers/signup-lists/${req.params.id}?notice=` + encodeURIComponent('List updated.'));
});

router.post('/signup-lists/:id/delete', async (req, res) => {
  await volunteers.deleteSignUpList(req.params.id);
  res.redirect('/main-admin/volunteers?tab=signup-lists&notice=' + encodeURIComponent('List deleted.'));
});

router.get('/signup-lists/:id', async (req, res) => {
  const list = await volunteers.getSignUpList(req.params.id);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-signup-list-detail', {
    title: list.title,
    list,
    items: await volunteers.itemsForSignUpList(list.id),
    events: await events.listEvents({}),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/signup-lists/:id/items', async (req, res) => {
  const itemName = (req.body.itemName || '').trim();
  if (!itemName) return res.redirect(`/main-admin/volunteers/signup-lists/${req.params.id}?error=` + encodeURIComponent('Item name is required.'));
  await volunteers.addSignUpItem(req.params.id, { itemName, quantityNeeded: parseInt(req.body.quantityNeeded, 10) || 1, notes: (req.body.notes || '').trim() });
  res.redirect(`/main-admin/volunteers/signup-lists/${req.params.id}?notice=` + encodeURIComponent('Item added.'));
});

router.post('/signup-lists/:id/items/:itemId/delete', async (req, res) => {
  await volunteers.deleteSignUpItem(req.params.itemId);
  res.redirect(`/main-admin/volunteers/signup-lists/${req.params.id}?notice=` + encodeURIComponent('Item removed.'));
});

// --- Volunteer Lists ---

router.post('/volunteer-lists', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/volunteers?tab=volunteer-lists&error=' + encodeURIComponent('List title is required.'));
  const id = await volunteers.createVolunteerList({
    title,
    description: (req.body.description || '').trim(),
    eventId: req.body.eventId ? parseInt(req.body.eventId, 10) : null,
  });
  res.redirect(`/main-admin/volunteers/volunteer-lists/${id}?notice=` + encodeURIComponent('List created.'));
});

router.post('/volunteer-lists/:id/update', async (req, res) => {
  await volunteers.updateVolunteerList(req.params.id, {
    title: (req.body.title || '').trim(),
    description: (req.body.description || '').trim(),
    eventId: req.body.eventId ? parseInt(req.body.eventId, 10) : null,
  });
  res.redirect(`/main-admin/volunteers/volunteer-lists/${req.params.id}?notice=` + encodeURIComponent('List updated.'));
});

router.post('/volunteer-lists/:id/delete', async (req, res) => {
  await volunteers.deleteVolunteerList(req.params.id);
  res.redirect('/main-admin/volunteers?tab=volunteer-lists&notice=' + encodeURIComponent('List deleted.'));
});

router.get('/volunteer-lists/:id', async (req, res) => {
  const list = await volunteers.getVolunteerList(req.params.id);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-volunteer-list-detail', {
    title: list.title,
    list,
    shifts: await volunteers.shiftsForVolunteerList(list.id),
    events: await events.listEvents({}),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteer-lists/:id/shifts', async (req, res) => {
  const jobName = (req.body.jobName || '').trim();
  if (!jobName) return res.redirect(`/main-admin/volunteers/volunteer-lists/${req.params.id}?error=` + encodeURIComponent('Job name is required.'));
  await volunteers.addVolunteerShift(req.params.id, {
    jobName,
    shiftDate: (req.body.shiftDate || '').trim(),
    startTime: (req.body.startTime || '').trim(),
    endTime: (req.body.endTime || '').trim(),
    slotsNeeded: parseInt(req.body.slotsNeeded, 10) || 1,
  });
  res.redirect(`/main-admin/volunteers/volunteer-lists/${req.params.id}?notice=` + encodeURIComponent('Shift added.'));
});

router.post('/volunteer-lists/:id/shifts/:shiftId/delete', async (req, res) => {
  await volunteers.deleteVolunteerShift(req.params.shiftId);
  res.redirect(`/main-admin/volunteers/volunteer-lists/${req.params.id}?notice=` + encodeURIComponent('Shift removed.'));
});

module.exports = router;
