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
const { listAdminPositions, membersByAdminPosition } = require('../utils/adminPositions');
const { activeParentAndAdminOptions } = require('../utils/members');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_volunteers'));

const TABS = ['committees', 'signup-lists', 'volunteer-lists'];

router.get('/', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'committees';
  res.render('main-admin-volunteers', {
    title: 'Volunteers',
    activeTab: tab,
    committees: tab === 'committees' ? await volunteers.listCommittees() : [],
    // "Add Committee" dialog's own Leader dropdown, grouped by position -
    // one option per current holder (see main-admin-volunteers.ejs's own
    // comment on why this is the whole list, not a list of position
    // titles).
    leaderPositions: tab === 'committees' ? await listAdminPositions() : [],
    leaderPositionMembers: tab === 'committees' ? await membersByAdminPosition() : {},
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
  const committeeId = await volunteers.createCommittee({
    name,
    description: (req.body.description || '').trim(),
    leaderMemberId: parseInt(req.body.leaderMemberId, 10) || null,
  });
  // Straight into the new committee's own page, not back to the list - a
  // real request ("when adding a new committee... then there should be an
  // add member button") wants adding members to follow right on from
  // creating the committee, and that button already lives on this page
  // (see the Members section below).
  res.redirect(`/main-admin/volunteers/committees/${committeeId}?notice=` + encodeURIComponent('Committee created.'));
});

router.post('/committees/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/main-admin/volunteers/committees/${req.params.id}?error=` + encodeURIComponent('Committee name is required.'));
  await volunteers.updateCommittee(req.params.id, {
    name,
    description: (req.body.description || '').trim(),
    leaderMemberId: parseInt(req.body.leaderMemberId, 10) || null,
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
    members: await volunteers.membersForCommittee(committee.id),
    leaderPositions: await listAdminPositions(),
    leaderPositionMembers: await membersByAdminPosition(),
    memberOptions: await activeParentAndAdminOptions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/committees/:id/members', async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  if (!memberId) return res.redirect(`/main-admin/volunteers/committees/${req.params.id}?error=` + encodeURIComponent('Select a member to add.'));
  await volunteers.addCommitteeMember(req.params.id, memberId);
  res.redirect(`/main-admin/volunteers/committees/${req.params.id}?notice=` + encodeURIComponent('Member added.'));
});

router.post('/committees/:id/members/:memberId/delete', async (req, res) => {
  await volunteers.removeCommitteeMember(req.params.id, req.params.memberId);
  res.redirect(`/main-admin/volunteers/committees/${req.params.id}?notice=` + encodeURIComponent('Member removed.'));
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
    // A real request: "add button that says copy link... you will have
    // copied the member link to the volunteer or signup list to paste
    // somewhere else to share" - the new standalone member-facing page
    // (routes/signup-volunteer-lists.js), not this Main Admin page.
    memberLink: `${req.protocol}://${req.get('host')}/signup-lists/${list.id}`,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "signup lists be able to add multiple items to a list
// in the popup before. Page only refreshes after adding however many
// needed" - the Add Item dialog (main-admin-signup-list-detail.ejs) now
// submits this via fetch() so an admin can add several items in a row
// without the popup closing/the page navigating away after each one;
// wantsJson mirrors routes/admin-members.js's own family-create branch.
router.post('/signup-lists/:id/items', async (req, res) => {
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  const itemName = (req.body.itemName || '').trim();
  if (!itemName) {
    if (wantsJson) return res.status(400).json({ error: 'Item name is required.' });
    return res.redirect(`/main-admin/volunteers/signup-lists/${req.params.id}?error=` + encodeURIComponent('Item name is required.'));
  }
  const quantityNeeded = parseInt(req.body.quantityNeeded, 10) || 1;
  const notes = (req.body.notes || '').trim();
  const itemId = await volunteers.addSignUpItem(req.params.id, { itemName, quantityNeeded, notes });
  if (wantsJson) {
    return res.json({
      item: { id: itemId, item_name: itemName, quantity_needed: quantityNeeded, notes, quantityClaimed: 0, claims: [] },
      deleteUrl: `/main-admin/volunteers/signup-lists/${req.params.id}/items/${itemId}/delete`,
    });
  }
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
    memberLink: `${req.protocol}://${req.get('host')}/volunteer-lists/${list.id}`,
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
