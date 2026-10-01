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
const { formatFriendlyTimestamp, formatFriendlyDateAndTime } = require('../utils/dates');
const events = require('../utils/events');
const signupLists = require('../utils/committeesAndSignupLists');
const notifications = require('../utils/notifications');
const { sanitizePostBody } = require('../utils/sanitizeHtml');

function withImageUrl(event) {
  return { ...event, imageUrl: events.eventImageUrl(event.image_key) };
}

// A real bug report: "parent portal, backing out of an event takes you to
// student portal. It should stay in parent portal." /events/:id is a
// shared public/member page (like /events itself - see below), so a
// dual-role account's own portal nav shell there depends on a ?portal=
// query param the visitor arrived with (views/events-detail.ejs's own
// effectivePortal). Every action on that same page (register, cancel,
// volunteer, claim a donation/food item, guest signup, etc.) redirects
// back to itself, so that param has to survive every one of those round
// trips too, or the very next render falls back to guessing (student
// before parent) and a dual-role account flips portals mid-visit.
function portalPrefix(req) {
  return req.query.portal === 'parent' || req.query.portal === 'student' ? `?portal=${req.query.portal}&` : '?';
}

// A real request: "when you click register next to a member the page
// will not refresh." /register and /unregister below still redirect for
// a plain form submit (progressive enhancement - the page still works
// with JS off), but public/js/events-detail-register.js's own fetch()
// calls send this same Accept header middleware/csrfProtection.js
// already checks for its own JSON error response, so both routes reuse
// that exact convention instead of inventing a second way to ask for
// JSON.
function wantsJson(req) {
  return !!(req.headers.accept && req.headers.accept.includes('application/json'));
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
  // A real bug report: "on the parent portal when you click on browse
  // events it switches to student portal. It should stay in parent
  // portal." This page is shared across every portal (see events-list.ejs's
  // own comment), so for a dual-role account it used to always guess
  // Student first with no way to say otherwise. portal-nav.ejs's own
  // Parent/Student nav links now tag their /events links with ?portal=
  // parent|student so the page renders the nav shell the visitor actually
  // clicked from instead of guessing from their full role list.
  const portalParam = req.query.portal === 'student' || req.query.portal === 'parent' ? req.query.portal : null;
  res.render('events-list', {
    title: 'Events',
    settings,
    view,
    portalParam,
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
  res.render('events-submit', { title: 'Submit an Event', error: req.query.error || null, submissionsOpen: settings.family_submit_events === 'yes' });
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
  // A real request: "a new card appears on the event for the member...
  // showing everything the member signed up for, date of registration and
  // what the member paid, what tickets they purchased for each member." -
  // joins the chosen ticket's own title and the charge registerForEvent
  // creates for it (utils/events.js's own chargeForConfirmedRegistration -
  // "we'll follow up separately on how to pay it" means amount_cents/
  // status here is what's OWED, not necessarily settled, same as every
  // other invoice in this app until a real payment processor exists).
  const myRegistrations = familyIds.length
    ? (
        await db
          .prepare(
            `SELECT er.*, tt.title AS "ticketTitle", pc.amount_cents AS "chargeAmountCents", pc.status AS "chargeStatus"
             FROM event_registrations er
             LEFT JOIN event_ticket_types tt ON tt.id = er.ticket_type_id
             LEFT JOIN payment_charges pc ON pc.id = er.charge_id
             WHERE er.event_id = ? AND er.status != 'cancelled' AND er.member_id IN (${familyIds.map(() => '?').join(',')})`
          )
          .all(event.id, ...familyIds)
      ).map((r) => ({ ...r, registeredAtLabel: formatFriendlyTimestamp(r.created_at) }))
    : [];
  const myVolunteerSignups = familyIds.length
    ? await db
        .prepare(
          `SELECT evs.*, evr.role_name AS "roleName" FROM event_volunteer_signups evs
           JOIN event_volunteer_roles evr ON evr.id = evs.volunteer_role_id
           WHERE evr.event_id = ? AND evs.member_id IN (${familyIds.map(() => '?').join(',')})`
        )
        .all(event.id, ...familyIds)
    : [];
  // A real request: "list volunteer positions signed up for, donations
  // signed up for and food signed up for" (Parent Portal's own "My
  // Registration" card) - same family-wide query shape as
  // myVolunteerSignups above, one per section.
  const myDonationClaims = familyIds.length
    ? await db
        .prepare(
          `SELECT edc.*, edi.item_name AS "itemName" FROM event_donation_claims edc
           JOIN event_donation_items edi ON edi.id = edc.donation_item_id
           WHERE edi.event_id = ? AND edc.member_id IN (${familyIds.map(() => '?').join(',')})`
        )
        .all(event.id, ...familyIds)
    : [];
  const myFoodClaims = familyIds.length
    ? await db
        .prepare(
          `SELECT efc.*, efi.item_name AS "itemName" FROM event_food_claims efc
           JOIN event_food_items efi ON efi.id = efc.food_item_id
           WHERE efi.event_id = ? AND efc.member_id IN (${familyIds.map(() => '?').join(',')})`
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

  // "If it allows for showing who has registered that will be listed
  // below the register button" - show_registrants_to_members is the
  // existing builder checkbox (previously stored but never read). A real
  // follow-up request: "when showing all members that are registered for
  // event it should be organized by family. Click on family to expand and
  // show more members of that family that are registered." Reuses the
  // exact same family-grouping routes/admin-events-registrations.js
  // already built for the admin roster (utils/events.js's own
  // familyGroupedRegistrationsForEvent) - that query doesn't filter by
  // status (the admin roster wants cancelled rows visible too), so
  // cancelled members/guests are filtered back out here, and any group
  // left with nobody active in it is dropped entirely.
  let registrantFamilyGroups = [];
  if (event.show_registrants_to_members) {
    registrantFamilyGroups = (await events.familyGroupedRegistrationsForEvent(event.id))
      .map((group) => ({ members: group.members.filter((r) => r.status !== 'cancelled'), guests: group.guests }))
      .filter((group) => group.members.length || group.guests.length);
  }

  // A real request: "if the event starts and ends the same day we only
  // need to see one date. Time should be stacked under date with a clock
  // icon." Same-day is decided off the already-Eastern-zoned date labels
  // (not the raw UTC starts_at/ends_at strings), so an event that only
  // crosses midnight in UTC but not in the timezone members actually see
  // times in still reads as one day.
  const startsDateAndTime = formatFriendlyDateAndTime(event.starts_at);
  const endsDateAndTime = formatFriendlyDateAndTime(event.ends_at);
  // A real request: "It will gray out member who are not of the age or
  // grade to register" - the same ageGroupAllowsMember/ageBucketAllowsMember
  // gates registerForEvent itself enforces server-side, checked here only
  // to decide which family members the Register list shows as clickable.
  const eligibleForRegistration = new Set(
    family.filter((m) => events.ageGroupAllowsMember(event, m) && events.ageBucketAllowsMember(event, m)).map((m) => m.id)
  );

  const portalParam = req.query.portal === 'student' || req.query.portal === 'parent' ? req.query.portal : null;
  // A real request: "will show on parent portal who Organized the event
  // and their email address" - see utils/events.js's own organizersForEvent.
  const organizers = await events.organizersForEvent(event.id);
  // A real request: "If a member is added as an organizer for an event,
  // on parent portal when they click on the event it will show an edit
  // event button at the top to allow them to change details." Reuses the
  // exact same Main Admin builder page (routes/admin-events.js's own
  // requireMainAdminOrEventOrganizer gate checks this same organizer
  // relationship again server-side - this is purely to decide whether to
  // show the button at all).
  const isOrganizer = req.portalAccount ? await events.isEventOrganizer(event.id, req.portalAccount.member_id) : false;
  res.render('events-detail', {
    title: event.title,
    settings,
    portalParam,
    organizers,
    isOrganizer,
    event: withImageUrl(event),
    startsLabel: formatFriendlyTimestamp(event.starts_at),
    endsLabel: event.ends_at ? formatFriendlyTimestamp(event.ends_at) : null,
    startsDateLabel: startsDateAndTime.dateLabel,
    startsTimeLabel: startsDateAndTime.timeLabel,
    endsDateLabel: endsDateAndTime.dateLabel,
    endsTimeLabel: endsDateAndTime.timeLabel,
    sameDay: !endsDateAndTime.dateLabel || startsDateAndTime.dateLabel === endsDateAndTime.dateLabel,
    eligibleForRegistration,
    family,
    familyIds,
    registeredMemberIds: myRegistrations.map((r) => r.member_id),
    myRegistrations,
    volunteeredKey: myVolunteerSignups.map((s) => `${s.volunteer_role_id}:${s.member_id}`),
    myVolunteerSignups,
    myDonationClaims,
    myFoodClaims,
    myGuestRegistrations,
    attachedSignUpLists,
    attachedVolunteerLists,
    registrantFamilyGroups,
    eligibilityLabel: events.eligibilitySummary(event),
    isRegistrationWindowOpen: await events.isRegistrationWindowOpen(event),
    priceLabel: event.price_cents == null ? null : `$${(event.price_cents / 100).toFixed(2)} per ${event.price_per}`,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "when they click on an event it shows a popup of the
// event card with photo, title, short description, cost and register now
// button." Small preview fragment fetched into the shared dialog on the
// Events list (public/js/events-card-view.js) - same "fetch -> swap
// dialog.innerHTML -> show" shape Parent Portal's own class-card popup
// uses (routes/parent-portal.js's own /classes/:id/fragment), just for
// browsing here rather than registering (Register Now goes to the real
// /events/:id page, which already has the full description/ticket/who's-
// registered/register flow).
router.get('/:id/fragment', async (req, res) => {
  const event = await events.getEvent(req.params.id);
  if (!event || event.status !== 'published') return res.status(404).send('Not found');
  if (event.visibility === 'members' && !req.portalAccount) return res.status(404).send('Not found');
  if (req.portalAccount) {
    const family = await familyForAccount(req.portalAccount.id);
    if (family.length && !(await events.eventVisibleToFamily(event.id, family))) return res.status(404).send('Not found');
  }
  const portalParam = req.query.portal === 'student' || req.query.portal === 'parent' ? req.query.portal : null;
  res.render('events-card-fragment', {
    event: withImageUrl(event),
    startsLabel: formatFriendlyTimestamp(event.starts_at),
    priceLabel: event.price_cents == null ? null : `$${(event.price_cents / 100).toFixed(2)} per ${event.price_per}`,
    portalParam,
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
  const ticketTypeId = req.body.ticketTypeId ? parseInt(req.body.ticketTypeId, 10) : null;
  // A real request: "if these items are selected when editing the event
  // with options added, then member should be asked when clicking
  // register along with the extra fields questions" - the Register
  // dialog (views/events-detail.ejs) now also collects these alongside
  // tickets/extra fields, same [].concat(... || []) shape a single
  // checked checkbox vs. several already needs elsewhere in this app.
  const volunteerRoleIds = [].concat(req.body.volunteerRoleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const donationItemIds = [].concat(req.body.donationItemIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const foodItemIds = [].concat(req.body.foodItemIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const result = await events.registerForEvent({ eventId, memberId, accountId: req.portalAccount.id, family, answers, ticketTypeId, volunteerRoleIds, donationItemIds, foodItemIds });
  if (!result.ok) {
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: result.error });
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent(result.error));
  }

  const event = await events.getEvent(eventId);
  await notifications.notify(req.portalAccount.id, 'event_registration', { title: `Registered: ${event.title}`, body: result.notice, linkUrl: back });
  if (wantsJson(req)) return res.json({ ok: true, notice: result.notice });
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(result.notice));
});

// A real request: "add a checkbox for include physical ticket. Members
// will be able to print tickets with a barcode for check in and out.
// Barcode is the same as their member ID number barcode used for
// classes." Only ever prints for a member this account's own family
// actually has, and only when that member's own registration is
// confirmed under a ticket type with includes_physical_ticket on -
// utils/events.js's own eventTicketDetailsForMember already enforces the
// latter two in its own WHERE clause; the family check here is this
// route's own responsibility, same as every other member-scoped action in
// this file never trusts an id from the request alone.
router.get('/:id/ticket', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.query.memberId, 10);
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const ticket = await events.eventTicketDetailsForMember(eventId, memberId);
  if (!ticket) return res.status(404).render('404', { title: 'Not Found' });
  res.render('events-ticket-print', {
    title: `Ticket - ${ticket.title}`,
    ticket,
    startsLabel: formatFriendlyTimestamp(ticket.starts_at),
  });
});

// A real request built a "my registrations" log page on both portals
// (routes/parent-portal.js's own /events, routes/student-portal.js's own
// /events) that also needs its own Cancel button - redirectTo lets it send
// a member back there instead of this event's own page, restricted to a
// fixed allowlist so this never becomes an open redirect.
const UNREGISTER_REDIRECT_ALLOWLIST = ['/parent/events', '/student/events'];

router.post('/:id/unregister', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = UNREGISTER_REDIRECT_ALLOWLIST.includes(req.body.redirectTo) ? req.body.redirectTo : `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    const message = 'You can only manage your own family\'s registrations.';
    if (wantsJson(req)) return res.status(403).json({ ok: false, error: message });
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent(message));
  }
  // A real request: "allow registration cancelations" checkbox - gates a
  // member's own self-service cancel here only; a Main Admin can always
  // cancel a registration from the Registrations page regardless.
  const event = await events.getEvent(eventId);
  if (event && !event.allow_registration_cancellations) {
    const message = 'Cancellations are not allowed for that event - contact an admin.';
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: message });
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent(message));
  }
  await events.cancelRegistration(eventId, memberId);
  if (wantsJson(req)) return res.json({ ok: true, notice: 'Registration cancelled.' });
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Registration cancelled.'));
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
  if (!event || !event.allow_guest_register) return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('This event isn\'t accepting guest registrations.'));

  const guestName = (req.body.guestName || '').trim();
  if (!guestName) return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('Guest name is required.'));
  await events.addGuestRegistration(
    eventId,
    { guestName, guestEmail: (req.body.guestEmail || '').trim(), guestPhone: (req.body.guestPhone || '').trim() },
    req.portalAccount.id
  );
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(`${guestName} registered as a guest.`));
});

router.post('/:id/unregister-guest', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const back = `/events/${eventId}`;
  const guestId = parseInt(req.body.guestId, 10);
  const guest = await db.prepare('SELECT * FROM event_guest_registrations WHERE id = ? AND event_id = ?').get(guestId, eventId);
  if (!guest || guest.registered_by_account_id !== req.portalAccount.id) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only manage guests you registered yourself.'));
  }
  await events.cancelGuestRegistration(guestId);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Guest registration cancelled.'));
});

router.post('/:id/volunteer-roles/:roleId/signup', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only sign up yourself or your own family.'));
  }
  const ok = await events.signUpForVolunteerRole(req.params.roleId, memberId, req.portalAccount.id);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(ok ? 'Signed up to volunteer.' : 'That role is already full, or you\'re already signed up.'));
});

router.post('/:id/volunteer-roles/:roleId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only manage your own family\'s volunteer signups.'));
  }
  await events.cancelVolunteerSignup(req.params.roleId, memberId);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Volunteer signup cancelled.'));
});

router.post('/:id/donation-items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await events.claimDonationItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(notice));
});

// A real request (Parent Portal "My Registration" card's own Edit
// Registration popup): "unassigned what they signed up for and register
// for something else" - same shape as /volunteer-roles/:roleId/cancel
// above, for the donation/food sections' own claims (cancelDonationClaim/
// cancelFoodClaim already existed in utils/events.js but had no route).
router.post('/:id/donation-claims/:claimId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only manage your own family\'s donation claims.'));
  }
  await events.cancelDonationClaim(req.params.claimId, memberId);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Donation claim cancelled.'));
});

// Food - a real request: "on the volunteer, donations and food pages..."
// Mirrors the donation-items claim route above exactly.
router.post('/:id/food-items/:itemId/claim', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await events.claimFoodItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(notice));
});

router.post('/:id/food-claims/:claimId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only manage your own family\'s food claims.'));
  }
  await events.cancelFoodClaim(req.params.claimId, memberId);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Food claim cancelled.'));
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

  const item = await db.prepare('SELECT list_id FROM sign_up_list_items WHERE id = ?').get(req.params.itemId);
  const list = item ? await signupLists.getSignUpList(item.list_id) : null;
  if (!list || !list.is_open) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('Signups are currently closed for that list.'));
  }
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only claim an item as yourself or your own family.'));
  }
  const claimed = await signupLists.claimSignUpItem(req.params.itemId, memberId, req.body.quantity, req.portalAccount.id);
  const notice = claimed > 0 ? `Thank you - ${claimed} claimed.` : 'That item no longer needs any more - thank you for checking!';
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent(notice));
});

router.post('/:id/volunteer-list-shifts/:shiftId/signup', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const shift = await db.prepare('SELECT list_id FROM volunteer_signup_list_shifts WHERE id = ?').get(req.params.shiftId);
  const list = shift ? await signupLists.getVolunteerList(shift.list_id) : null;
  if (!list || !list.is_open) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('Signups are currently closed for that list.'));
  }
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only sign up yourself or your own family.'));
  }
  await signupLists.signUpForShift(req.params.shiftId, memberId, req.portalAccount.id);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Signed up - thank you for volunteering!'));
});

router.post('/:id/volunteer-list-shifts/:shiftId/cancel', requirePortalAuth, async (req, res) => {
  const eventId = req.params.id;
  const memberId = parseInt(req.body.memberId, 10);
  const back = `/events/${eventId}`;

  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(back + portalPrefix(req) + 'error=' + encodeURIComponent('You can only manage your own family\'s volunteer signups.'));
  }
  await signupLists.cancelShiftSignup(req.params.shiftId, memberId);
  res.redirect(back + portalPrefix(req) + 'notice=' + encodeURIComponent('Volunteer signup cancelled.'));
});

module.exports = router;
