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
const { familyForAccount } = require('../utils/portalAuth');
const { formatFriendlyTimestamp } = require('../utils/dates');
const events = require('../utils/events');
const notifications = require('../utils/notifications');

function withImageUrl(event) {
  return { ...event, imageUrl: event.image_key ? `/uploads/events/${event.image_key}` : null };
}

// Builds a plain Sunday-first month grid (an array of weeks, each an
// array of {date, inMonth, events} day cells) for the calendar view -
// kept server-side rather than in the template, same "the view only
// displays, the route computes" split as every other page in this app.
function monthGrid(monthParam, eventList) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (/^\d{4}-\d{2}$/.test(monthParam || '')) {
    year = parseInt(monthParam.slice(0, 4), 10);
    month = parseInt(monthParam.slice(5, 7), 10) - 1;
  }
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startOffset = firstOfMonth.getUTCDay();
  const gridStart = new Date(Date.UTC(year, month, 1 - startOffset));
  const eventsByDate = {};
  for (const e of eventList) {
    const dateKey = (e.starts_at || '').slice(0, 10);
    (eventsByDate[dateKey] = eventsByDate[dateKey] || []).push(e);
  }

  const weeks = [];
  let cursor = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dateKey = cursor.toISOString().slice(0, 10);
      week.push({ dateKey, day: cursor.getUTCDate(), inMonth: cursor.getUTCMonth() === month, events: eventsByDate[dateKey] || [] });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    weeks.push(week);
  }

  const prevMonth = new Date(Date.UTC(year, month - 1, 1));
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  return {
    weeks,
    label: firstOfMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    prevParam: `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`,
    nextParam: `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

// GET /events - public + member events, filtered to what THIS visitor is
// actually allowed to see: signed out sees visibility='public' only; a
// signed-in portal account (any role) sees every published event, minus
// any section-restricted event none of their own family belongs to
// ("select sections only that can view or signup for events" - a
// restricted event is hidden entirely, not just its registration
// button). approvalStatus:'approved' is a safety net for a member-
// submitted event a Main Admin published without first deciding its
// submission - see utils/events.js's own createEvent comment.
router.get('/', async (req, res) => {
  const upcoming = await events.listEvents({ status: 'published', upcomingOnly: true, approvalStatus: 'approved' });
  let visible = req.portalAccount ? upcoming : upcoming.filter((e) => e.visibility === 'public');
  if (req.portalAccount) {
    const family = await familyForAccount(req.portalAccount.id);
    const flags = await Promise.all(visible.map((e) => events.eventVisibleToFamily(e.id, family)));
    visible = visible.filter((e, i) => flags[i]);
  }
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const view = req.query.view === 'calendar' ? 'calendar' : 'list';
  const mapped = visible.map((e) => ({ ...withImageUrl(e), startsLabel: formatFriendlyTimestamp(e.starts_at) }));
  res.render('events-list', {
    title: 'Events',
    settings,
    view,
    events: mapped,
    calendar: view === 'calendar' ? monthGrid(req.query.month, mapped) : null,
  });
});

router.get('/print', async (req, res) => {
  const upcoming = await events.listEvents({ status: 'published', upcomingOnly: true, approvalStatus: 'approved' });
  let visible = req.portalAccount ? upcoming : upcoming.filter((e) => e.visibility === 'public');
  if (req.portalAccount) {
    const family = await familyForAccount(req.portalAccount.id);
    const flags = await Promise.all(visible.map((e) => events.eventVisibleToFamily(e.id, family)));
    visible = visible.filter((e, i) => flags[i]);
  }
  res.render('events-print', {
    title: 'Events Calendar',
    events: visible.map((e) => ({ ...e, startsLabel: formatFriendlyTimestamp(e.starts_at) })),
  });
});

// GET/POST /events/submit - "members should be able to add events for
// approval". Any signed-in portal account (any role) can propose an
// event; it lands in the Main Admin's Submitted Events queue (utils/
// events.js's submitEvent) and is invisible everywhere else until
// decided.
router.get('/submit', requirePortalAuth, async (req, res) => {
  res.render('events-submit', { title: 'Submit an Event', error: req.query.error || null });
});

router.post('/submit', requirePortalAuth, async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = req.body.startsAt ? req.body.startsAt.replace('T', ' ') + ':00' : null;
  if (!title || !startsAt) {
    return res.redirect('/events/submit?error=' + encodeURIComponent('Title and start date/time are required.'));
  }
  await events.submitEvent(
    {
      title,
      description: (req.body.description || '').trim(),
      location: (req.body.location || '').trim(),
      startsAt,
      endsAt: req.body.endsAt ? req.body.endsAt.replace('T', ' ') + ':00' : null,
      visibility: 'members',
    },
    req.portalAccount.id
  );
  res.redirect('/events?notice=' + encodeURIComponent('Thanks - your event was submitted for approval.'));
});

router.get('/:id', async (req, res) => {
  const event = await events.getEventWithDetails(req.params.id);
  if (!event || event.status === 'draft') return res.status(404).render('404', { title: 'Not Found' });
  if (event.visibility === 'members' && !req.portalAccount) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }

  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const family = req.portalAccount ? await familyForAccount(req.portalAccount.id) : [];
  if (family.length && !(await events.eventVisibleToFamily(event.id, family))) {
    return res.status(404).render('404', { title: 'Not Found' });
  }
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
    isRegistrationWindowOpen: await events.isRegistrationWindowOpen(event),
    priceLabel: event.price_cents == null ? null : `$${(event.price_cents / 100).toFixed(2)} per ${event.price_per}`,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/register', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  const result = await events.registerForEvent({ eventId, memberId, accountId: req.portalAccount.id, family });
  if (!result.ok) return res.redirect(back + '?error=' + encodeURIComponent(result.error));

  const event = await events.getEvent(eventId);
  await notifications.notify(req.portalAccount.id, 'event_registration', { title: `Registered: ${event.title}`, body: result.notice, linkUrl: back });
  res.redirect(back + '?notice=' + encodeURIComponent(result.notice));
});

router.post('/:id/unregister', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
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

  const family = await familyForAccount(req.portalAccount.id);
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

  const family = await familyForAccount(req.portalAccount.id);
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

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await events.claimDonationItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

module.exports = router;
