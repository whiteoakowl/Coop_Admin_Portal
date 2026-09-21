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
const signupLists = require('../utils/committeesAndSignupLists');
const notifications = require('../utils/notifications');
const { sanitizePostBody } = require('../utils/sanitizeHtml');

function withImageUrl(event) {
  return { ...event, imageUrl: event.image_key ? `/uploads/events/${event.image_key}` : null };
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
  const eventSettings = await events.getEventSettings();
  const view = req.query.view ? (req.query.view === 'calendar' ? 'calendar' : 'list') : eventSettings.default_calendar_view;
  const mapped = visible.map((e) => ({ ...withImageUrl(e), startsLabel: formatFriendlyTimestamp(e.starts_at) }));
  res.render('events-list', {
    title: 'Events',
    settings,
    view,
    events: mapped,
    calendar: view === 'calendar' ? events.monthGrid(req.query.month, mapped) : null,
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
  const settings = await events.getEventSettings();
  res.render('events-submit', { title: 'Submit an Event', error: req.query.error || null, submissionsOpen: settings.family_submit_events !== 'no' });
});

router.post('/submit', requirePortalAuth, async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = req.body.startsAt ? req.body.startsAt.replace('T', ' ') + ':00' : null;
  if (!title || !startsAt) {
    return res.redirect('/events/submit?error=' + encodeURIComponent('Title and start date/time are required.'));
  }
  const result = await events.submitEvent(
    {
      title,
      description: sanitizePostBody(req.body.description || ''),
      location: (req.body.location || '').trim(),
      startsAt,
      endsAt: req.body.endsAt ? req.body.endsAt.replace('T', ' ') + ':00' : null,
      visibility: 'members',
    },
    req.portalAccount.id
  );
  if (result === null) {
    return res.redirect('/events/submit?error=' + encodeURIComponent('Event submissions are turned off right now.'));
  }
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
  const myGuestRegistrations = req.portalAccount
    ? await db
        .prepare("SELECT * FROM event_guest_registrations WHERE event_id = ? AND registered_by_account_id = ? AND status != 'cancelled'")
        .all(event.id, req.portalAccount.id)
    : [];

  // A real request: "be able to attach these lists to events" - see
  // routes/main-admin-volunteers.js/utils/committeesAndSignupLists.js.
  const attachedSignUpLists = await signupLists.signUpListsForEvent(event.id);
  for (const list of attachedSignUpLists) list.items = await signupLists.itemsForSignUpList(list.id);
  const attachedVolunteerLists = await signupLists.volunteerListsForEvent(event.id);
  for (const list of attachedVolunteerLists) list.shifts = await signupLists.shiftsForVolunteerList(list.id);

  res.render('events-detail', {
    title: event.title,
    settings,
    event: withImageUrl(event),
    startsLabel: formatFriendlyTimestamp(event.starts_at),
    endsLabel: event.ends_at ? formatFriendlyTimestamp(event.ends_at) : null,
    family,
    familyIds,
    registeredMemberIds: myRegistrations.map((r) => r.member_id),
    volunteeredKey: myVolunteerSignups.map((s) => `${s.volunteer_role_id}:${s.member_id}`),
    myGuestRegistrations,
    attachedSignUpLists,
    attachedVolunteerLists,
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
  // A real request: "extra fields is where you can add extra form type
  // questions for people signing up for an event" - answers[] here comes
  // from that per-event event_extra_fields list (views/events-detail.ejs
  // renders one input per field, named answers[f<fieldId>] - the "f"
  // prefix keeps qs's body parser from reading a purely-numeric bracket
  // key as an ARRAY index instead of an object key, which silently
  // dropped every answer whose field id happened to look like one).
  const rawAnswers = req.body.answers || {};
  const answers = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const match = /^f(\d+)$/.exec(key);
    if (match) answers[match[1]] = value;
  }
  const result = await events.registerForEvent({ eventId, memberId, accountId: req.portalAccount.id, family, answers });
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
  // A real request: "allow registration cancelations" checkbox - gates a
  // member's own self-service cancel here only; a Main Admin can always
  // cancel a registration from the Registrations page regardless.
  const event = await events.getEvent(eventId);
  if (event && !event.allow_registration_cancellations) {
    return res.redirect(back + '?error=' + encodeURIComponent('Cancellations are not allowed for that event - contact an admin.'));
  }
  await events.cancelRegistration(eventId, memberId);
  res.redirect(back + '?notice=' + encodeURIComponent('Registration cancelled.'));
});

// A real request: "guest check in shouldn't be [on the Attendance page].
// that should be under settings for each individual event only. to
// allow guest to signup, then they will appear on the event roster." The
// event's own "Guests can register" setting (allow_guest_register,
// already a real checkbox on the builder's own registration rules) had
// nothing that actually let a guest register at all before this - the
// only way one ever got added to event_guest_registrations was a Main
// Admin typing them in by hand from the Attendance page (now removed -
// see routes/admin-events.js's own comment). This is that missing
// member-facing counterpart: any signed-in account can add a guest to an
// event that allows them, same event_guest_registrations row/table the
// admin-side attendance roster and check-in scan already read from.
router.post('/:id/register-guest', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const back = `/events/${eventId}`;
  const event = await events.getEvent(eventId);
  if (!event || !event.allow_guest_register) return res.redirect(back + '?error=' + encodeURIComponent('This event isn\'t accepting guest registrations.'));

  const guestName = (req.body.guestName || '').trim();
  if (!guestName) return res.redirect(back + '?error=' + encodeURIComponent('Guest name is required.'));
  await events.addGuestRegistration(
    eventId,
    { guestName, guestEmail: (req.body.guestEmail || '').trim(), guestPhone: (req.body.guestPhone || '').trim() },
    req.portalAccount.id
  );
  res.redirect(back + '?notice=' + encodeURIComponent(`${guestName} registered as a guest.`));
});

router.post('/:id/unregister-guest', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const back = `/events/${eventId}`;
  const guestId = parseInt(req.body.guestId, 10);
  const guest = await db.prepare('SELECT * FROM event_guest_registrations WHERE id = ? AND event_id = ?').get(guestId, eventId);
  if (!guest || guest.registered_by_account_id !== req.portalAccount.id) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage guests you registered yourself.'));
  }
  await events.cancelGuestRegistration(guestId);
  res.redirect(back + '?notice=' + encodeURIComponent('Guest registration cancelled.'));
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

// Food - a real request: "on the volunteer, donations and food pages..."
// Mirrors the donation-items claim route above exactly.
router.post('/:id/food-items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await events.claimFoodItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

// A real request: "be able to attach these lists to events" (Main
// Admin's own Sign-Up Lists/Volunteer Lists, see utils/
// committeesAndSignupLists.js) - once a list carries this event's own id,
// members see it right on the event page and can claim an item/shift the
// same way they already claim a donation/food item above.
router.post('/:id/signup-list-items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await signupLists.claimSignUpItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

router.post('/:id/volunteer-list-shifts/:shiftId/signup', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only sign up yourself or your own family.'));
  }
  await signupLists.signUpForShift(req.params.shiftId, memberId, req.portalAccount.id);
  res.redirect(back + '?notice=' + encodeURIComponent('Signed up - thank you for volunteering!'));
});

router.post('/:id/volunteer-list-shifts/:shiftId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage your own family\'s volunteer signups.'));
  }
  await signupLists.cancelShiftSignup(req.params.shiftId, memberId);
  res.redirect(back + '?notice=' + encodeURIComponent('Volunteer signup cancelled.'));
});

module.exports = router;
