// Member/public-facing Events (Community & Commerce track, item 1),
// mounted at /events (server.js). Browsing works for a signed-out
// visitor too (visibility: 'public' events only) - the "public/member
// visibility" split the handoff calls for - while registering, signing
// up to volunteer, or claiming a donation item all require a signed-in
// portal account (any role; events aren't scoped to one portal the way
// Parent Portal's own class registration is).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { formatFriendlyTimestamp } = require('../utils/dates');
const events = require('../utils/events');

// Self + every other active member sharing the account's own family_id -
// the full set of people this account can register/volunteer/claim a
// donation item for, the same "any of my own family, not just myself"
// scope parent-portal.js's own childrenForAccount established, just not
// narrowed to students only - a teacher or co-op admin account should be
// able to sign up their whole family for an event too, not just their
// kids.
async function familyForAccount(account) {
  const self = await memberForAccount(account.id);
  if (!self) return [];
  if (!self.family_id) return [self];
  const rest = await db.prepare("SELECT * FROM members WHERE family_id = ? AND id != ? AND active = 1 ORDER BY LOWER(name)").all(self.family_id, self.id);
  return [self, ...rest];
}

function withImageUrl(event) {
  return { ...event, imageUrl: event.image_key ? `/uploads/events/${event.image_key}` : null };
}

// GET /events - public + member events, filtered to what THIS visitor is
// actually allowed to see: signed out sees visibility='public' only; any
// signed-in portal account (any role) sees every published event.
router.get('/', async (req, res) => {
  const upcoming = await events.listEvents({ status: 'published', upcomingOnly: true });
  const visible = req.portalAccount ? upcoming : upcoming.filter((e) => e.visibility === 'public');
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('events-list', {
    title: 'Events',
    settings,
    events: visible.map((e) => ({ ...withImageUrl(e), startsLabel: formatFriendlyTimestamp(e.starts_at) })),
  });
});

router.get('/:id', async (req, res) => {
  const event = await events.getEventWithDetails(req.params.id);
  if (!event || event.status === 'draft') return res.status(404).render('404', { title: 'Not Found' });
  if (event.visibility === 'members' && !req.portalAccount) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }

  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const family = req.portalAccount ? await familyForAccount(req.portalAccount) : [];
  const familyIds = family.map((m) => m.id);
  const myRegistrations = familyIds.length
    ? await db.prepare(`SELECT * FROM event_registrations WHERE event_id = ? AND status != 'cancelled' AND member_id IN (${familyIds.map(() => '?').join(',')})`).all(event.id, ...familyIds)
    : [];
  const myVolunteerSignups = familyIds.length
    ? await db
        .prepare(
          `SELECT evs.* FROM event_volunteer_signups evs
           JOIN event_volunteer_roles evr ON evr.id = evs.volunteer_role_id
           WHERE evr.event_id = ? AND evs.member_id IN (${familyIds.map(() => '?').join(',')})`
        )
        .all(event.id, ...familyIds)
    : [];

  res.render('events-detail', {
    title: event.title,
    settings,
    event: withImageUrl(event),
    startsLabel: formatFriendlyTimestamp(event.starts_at),
    endsLabel: event.ends_at ? formatFriendlyTimestamp(event.ends_at) : null,
    family,
    registeredMemberIds: myRegistrations.map((r) => r.member_id),
    volunteeredKey: myVolunteerSignups.map((s) => `${s.volunteer_role_id}:${s.member_id}`),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/register', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only register yourself or your own family.'));
  }
  const status = await events.registerForEvent(eventId, memberId, req.portalAccount.id);
  if (!status) return res.redirect(back + '?error=' + encodeURIComponent('That event no longer exists.'));

  const member = family.find((m) => m.id === memberId);
  const notice = status === 'confirmed' ? `${member.name} is registered.` : `That event is full - ${member.name} has been added to the waitlist.`;
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

router.post('/:id/unregister', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage your own family\'s registrations.'));
  }
  await events.cancelRegistration(eventId, memberId);
  res.redirect(back + '?notice=' + encodeURIComponent('Registration cancelled.'));
});

router.post('/:id/volunteer-roles/:roleId/signup', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only sign up yourself or your own family.'));
  }
  const ok = await events.signUpForVolunteerRole(req.params.roleId, memberId, req.portalAccount.id);
  res.redirect(back + '?notice=' + encodeURIComponent(ok ? 'Signed up to volunteer.' : 'That role is already full, or you\'re already signed up.'));
});

router.post('/:id/volunteer-roles/:roleId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage your own family\'s volunteer signups.'));
  }
  await events.cancelVolunteerSignup(req.params.roleId, memberId);
  res.redirect(back + '?notice=' + encodeURIComponent('Volunteer signup cancelled.'));
});

router.post('/:id/donation-items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await events.claimDonationItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

module.exports = router;
