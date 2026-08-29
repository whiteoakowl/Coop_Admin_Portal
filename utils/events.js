// Events (Community & Commerce track, item 1) - the backbone Volunteer
// signups (item 2) and Donation signups (item 3) hang directly off of,
// via event_volunteer_roles/event_volunteer_signups and
// event_donation_items/event_donation_claims. See supabase/migrations/
// 20260825030000_events_module.sql for the original schema and
// 20260826040000_events_registration_rules.sql for the registration-rules
// extension this file also implements: a registration open/close window,
// a family cap alongside the existing per-person capacity, age/grade
// restriction, per-person/per-family pricing with a waitlist (same
// position-tracking/charge-on-promotion shape utils/classRegistration.js
// already established for Classes), section restriction (this one also
// hides the event entirely from members outside it, not just registration
// - "select sections only that can view or signup"), member-submitted
// events awaiting Main Admin approval, and lightweight guest registration.
//
// Registration/signup/claim all follow the same shape Track A's own
// class_registrations already established (routes/parent-portal.js): the
// person being registered is a real `members` row (so a parent can act
// for any of their own family, not just themselves), while the account
// that took the action is recorded separately for accountability.
const db = require('../db');
const { eventSectionIds, memberSatisfiesRestriction, sectionIdsForMember } = require('./sections');
const { createCharge, amountPaidForCharge, cancelCharge } = require('./payments');
const { GRADE_OPTIONS } = require('./membership');
const { lastNameOf } = require('./members');
const notifications = require('./notifications');

// The Create New Event wizard's own Event Type / Language dropdowns - a
// fixed, short list is plenty for a single co-op (unlike GRADE_OPTIONS/
// sections, nothing else in the app reads these back to gate anything,
// they're purely descriptive fields shown on the event).
const EVENT_TYPES = ['In-Person', 'Virtual', 'Hybrid'];
const LANGUAGES = ['English', 'Spanish', 'Other'];

// A real request: "every list should always be alphabetical according to
// last name." Every list here carries a person's display name under a
// different key depending on the query (memberName from a JOIN,
// guest_name on a guest row), so this takes the field name rather than
// assuming `.name` the way utils/members.js's own byLastName does.
function sortByLastNameField(rows, field) {
  return rows.sort((a, b) => lastNameOf(a[field]).localeCompare(lastNameOf(b[field]), undefined, { sensitivity: 'base' }) || a[field].localeCompare(b[field], undefined, { sensitivity: 'base' }));
}

// Comma-joined list of GRADE_OPTIONS strings, same parse-a-multi-select-
// TEXT-column shape as classSchedule.js's own ageGroupList (a different
// grade vocabulary though - see the migration's own comment on why this
// reuses GRADE_OPTIONS instead).
function parseAgeGroupList(value) {
  return (value || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

function ageGroupAllowsMember(event, member) {
  const allowed = parseAgeGroupList(event.age_group);
  if (allowed.length === 0) return true;
  return allowed.includes(member.grade_level);
}

// "adult" = parent/admin member_type, "child" = student - matches
// members.member_type's own three-way vocabulary (parent/student/admin).
function memberIsAdult(member) {
  return member.member_type === 'parent' || member.member_type === 'admin';
}

function registrationWindowStatus(event) {
  // now_text() lives in Postgres, not here - callers that need "is it
  // open right now" always go through isRegistrationWindowOpen below,
  // which asks the database for `now`, same as registrationWindows.js's
  // own isRegistrationOpenForAccount does for classes.
  return { opensAt: event.registration_opens_at, closesAt: event.registration_closes_at };
}

async function isRegistrationWindowOpen(event) {
  if (!event.registration_opens_at && !event.registration_closes_at) return true;
  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  if (event.registration_opens_at && nowText < event.registration_opens_at) return false;
  if (event.registration_closes_at && nowText >= event.registration_closes_at) return false;
  return true;
}

async function listEvents({ status, visibility, upcomingOnly, approvalStatus, categoryId } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (visibility) {
    clauses.push('visibility = ?');
    params.push(visibility);
  }
  if (approvalStatus) {
    clauses.push('approval_status = ?');
    params.push(approvalStatus);
  }
  if (categoryId) {
    clauses.push('category_id = ?');
    params.push(categoryId);
  }
  if (upcomingOnly) clauses.push("starts_at >= now_text()");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT e.*, ec.name AS "categoryName", ec.color AS "categoryColor" FROM events e LEFT JOIN event_categories ec ON ec.id = e.category_id ${where} ORDER BY starts_at`).all(...params);
}

async function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

// A lighter-weight version of getEventWithDetails's own registrationCount
// - just the one count, for the Events > Event Attendance tab's own
// per-event list (routes/admin-events.js), which doesn't need the rest of
// that function's volunteer-role/donation-item detail.
async function registrationCountForEvent(id) {
  return Number((await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(id)).c);
}

// Full detail for one event page (admin management or a member's own
// view of it): the event row, its category, its section restriction, its
// volunteer roles each with their own signups + filled/needed counts, its
// donation items each with their own claims + claimed/needed totals, its
// guest registrations, and the event's own registration/waitlist counts
// (families counted distinctly from people, for the family cap). quantity
// _claimed is always summed live from event_donation_claims here, never a
// stored counter - see the migration's own comment on why.
async function getEventWithDetails(id) {
  const event = await db
    .prepare('SELECT e.*, ec.name AS "categoryName", ec.color AS "categoryColor" FROM events e LEFT JOIN event_categories ec ON ec.id = e.category_id WHERE e.id = ?')
    .get(id);
  if (!event) return null;

  const roles = await db.prepare('SELECT * FROM event_volunteer_roles WHERE event_id = ? ORDER BY position, id').all(id);
  for (const role of roles) {
    role.signups = sortByLastNameField(
      await db
        .prepare(
          `SELECT evs.*, m.name AS "memberName" FROM event_volunteer_signups evs
           JOIN members m ON m.id = evs.member_id
           WHERE evs.volunteer_role_id = ?`
        )
        .all(role.id),
      'memberName'
    );
    role.filled = role.signups.length;
    role.remaining = Math.max(0, role.slots_needed - role.filled);
  }

  const donationItems = await db.prepare('SELECT * FROM event_donation_items WHERE event_id = ? ORDER BY position, id').all(id);
  for (const item of donationItems) {
    item.claims = sortByLastNameField(
      await db
        .prepare(
          `SELECT edc.*, m.name AS "memberName" FROM event_donation_claims edc
           JOIN members m ON m.id = edc.member_id
           WHERE edc.donation_item_id = ?`
        )
        .all(item.id),
      'memberName'
    );
    item.quantityClaimed = item.claims.reduce((sum, c) => sum + Number(c.quantity_claimed), 0);
    item.remaining = Math.max(0, item.quantity_needed - item.quantityClaimed);
  }

  const registrationCount = Number(
    (await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(id)).c
  );
  const waitlistCount = Number(
    (await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'waitlisted'").get(id)).c
  );
  const familyCount = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(DISTINCT COALESCE(m.family_id, -m.id)) AS c FROM event_registrations er
           JOIN members m ON m.id = er.member_id
           WHERE er.event_id = ? AND er.status = 'confirmed'`
        )
        .get(id)
    ).c
  );
  const guestRegistrations = sortByLastNameField(
    await db.prepare("SELECT * FROM event_guest_registrations WHERE event_id = ? AND status != 'cancelled'").all(id),
    'guest_name'
  );

  return {
    ...event,
    volunteerRoles: roles,
    donationItems,
    registrationCount,
    waitlistCount,
    familyCount,
    guestRegistrations,
    sectionIds: await eventSectionIds(id),
  };
}

function eventFields(data) {
  return [
    data.title,
    data.description || null,
    data.category || null,
    data.categoryId ?? null,
    data.location || null,
    data.startsAt,
    data.endsAt || null,
    data.visibility,
    data.capacity ?? null,
    data.familyCapacity ?? null,
    data.ageGroup || null,
    data.registrationOpensAt || null,
    data.registrationClosesAt || null,
    data.allowAdultRegister ? 1 : 0,
    data.allowChildRegister ? 1 : 0,
    data.priceCents ?? null,
    data.pricePer === 'family' ? 'family' : 'person',
    data.slug || null,
    data.eventType || null,
    data.shortDescription || null,
    data.language || null,
    data.organizedBy || null,
    data.tags || null,
  ];
}

// status defaults to 'draft' (every pre-wizard caller, and a member's own
// submitEvent below, still create a plain draft) - the Create New Event
// wizard's own Publish Event button is the one caller that now passes
// 'published' straight through, so publishing no longer needs a separate
// save-then-status round trip.
async function createEvent(data, accountId, { submittedByAccountId = null, status = 'draft' } = {}) {
  const approvalStatus = submittedByAccountId ? 'pending' : 'approved';
  const info = await db
    .prepare(
      `INSERT INTO events (
         title, description, category, category_id, location, starts_at, ends_at, visibility, capacity,
         family_capacity, age_group, registration_opens_at, registration_closes_at,
         allow_adult_register, allow_child_register, price_cents, price_per,
         slug, event_type, short_description, language, organized_by, tags,
         created_by_account_id, submitted_by_account_id, approval_status, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...eventFields(data), accountId, submittedByAccountId, approvalStatus, status);
  return info.lastInsertRowid;
}

async function updateEvent(id, data) {
  await db
    .prepare(
      `UPDATE events SET
         title = ?, description = ?, category = ?, category_id = ?, location = ?, starts_at = ?, ends_at = ?, visibility = ?, capacity = ?,
         family_capacity = ?, age_group = ?, registration_opens_at = ?, registration_closes_at = ?,
         allow_adult_register = ?, allow_child_register = ?, price_cents = ?, price_per = ?,
         slug = ?, event_type = ?, short_description = ?, language = ?, organized_by = ?, tags = ?,
         updated_at = now_text()
       WHERE id = ?`
    )
    .run(...eventFields(data), id);
}

async function setEventSections(eventId, sectionIds) {
  const ids = [].concat(sectionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await db.prepare('DELETE FROM event_sections WHERE event_id = ?').run(eventId);
  for (const sectionId of ids) {
    await db.prepare('INSERT INTO event_sections (event_id, section_id) VALUES (?, ?)').run(eventId, sectionId);
  }
}

async function setEventStatus(id, status) {
  await db.prepare('UPDATE events SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

async function setEventImage(id, imageKey) {
  await db.prepare('UPDATE events SET image_key = ?, updated_at = now_text() WHERE id = ?').run(imageKey, id);
}

async function deleteEvent(id) {
  await db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

// --- Categories (Main-Admin managed, same shape as utils/sections.js's sections) ---

async function listCategories() {
  return db.prepare('SELECT * FROM event_categories ORDER BY position, name').all();
}

async function createCategory(name, color) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_categories').get()).p) + 1;
  await db.prepare('INSERT INTO event_categories (name, color, position) VALUES (?, ?, ?)').run(name, color || '#EE9A4D', position);
}

async function updateCategory(id, name, color) {
  await db.prepare('UPDATE event_categories SET name = ?, color = ? WHERE id = ?').run(name, color || '#EE9A4D', id);
}

async function deleteCategory(id) {
  await db.prepare('DELETE FROM event_categories WHERE id = ?').run(id);
}

// --- Member-submitted events, awaiting Main Admin approval ---

// A member submitting an event is really just createEvent with
// submittedByAccountId set - approval_status starts 'pending' and the
// event starts 'draft' either way, so a pending submission never shows
// up anywhere but the submitter's own "my submissions" and the Main
// Admin approval queue until it's actually decided.
async function submitEvent(data, accountId) {
  return createEvent(data, accountId, { submittedByAccountId: accountId });
}

async function decideSubmission(eventId, approve) {
  const event = await getEvent(eventId);
  if (!event || event.approval_status !== 'pending') return null;
  await db.prepare('UPDATE events SET approval_status = ?, updated_at = now_text() WHERE id = ?').run(approve ? 'approved' : 'rejected', eventId);
  if (event.submitted_by_account_id) {
    await notifications.notify(event.submitted_by_account_id, 'event_submission_decided', {
      title: approve ? `Event approved: ${event.title}` : `Event not approved: ${event.title}`,
      body: approve
        ? `Your submitted event "${event.title}" was approved. A Main Admin still needs to publish it before it's visible on the calendar.`
        : `Your submitted event "${event.title}" was not approved.`,
      linkUrl: '/events',
    });
  }
  return approve ? 'approved' : 'rejected';
}

// --- Section-based "can this family even see it" visibility ---

// Unions every family member's own sections into one Set, then checks the
// event's restriction against that union - an event restricted to a
// section any one family member holds is visible to the whole family (a
// parent needs to see an event to register their child for it, even if
// the parent themselves isn't personally in that section). Unrestricted
// events (no event_sections rows) are always visible - the usual "empty
// means unrestricted" convention.
async function eventVisibleToFamily(eventId, family) {
  const restriction = await eventSectionIds(eventId);
  if (restriction.length === 0) return true;
  const union = new Set();
  for (const member of family) {
    for (const id of await sectionIdsForMember(member.id)) union.add(id);
  }
  return memberSatisfiesRestriction(union, restriction);
}

async function registrationsForEvent(eventId) {
  const rows = await db
    .prepare(
      `SELECT er.*, m.name AS "memberName", m.member_code AS "memberCode" FROM event_registrations er
       JOIN members m ON m.id = er.member_id
       WHERE er.event_id = ?`
    )
    .all(eventId);
  // Cancelled registrations sink to the bottom (real vs. historical), last
  // name alphabetical within each group.
  return rows.sort((a, b) => {
    const cancelledDiff = (a.status === 'cancelled' ? 1 : 0) - (b.status === 'cancelled' ? 1 : 0);
    if (cancelledDiff) return cancelledDiff;
    return lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) || a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' });
  });
}

// --- Registration (member/public, with the full rules engine) ---

// Creates (or, for 'family' pricing, reuses a sibling's already-created)
// the payment_charges row for a member who just became 'confirmed' for a
// priced event - same shared-between-initial-registration-and-waitlist-
// promotion shape as classRegistration.js's own chargeForConfirmedRegistration,
// for the same reason (a promotion owes money starting now too). Must be
// called with the open transaction handle - see utils/payments.js's own
// createCharge comment on why.
async function chargeForConfirmedRegistration(tx, event, member, accountId) {
  if (event.price_cents == null) return null;
  let reuseCharge = null;
  if (event.price_per === 'family' && member.family_id) {
    reuseCharge = await tx
      .prepare(
        `SELECT er.charge_id FROM event_registrations er
         JOIN members m ON m.id = er.member_id
         WHERE er.event_id = ? AND m.family_id = ? AND er.status != 'cancelled' AND er.charge_id IS NOT NULL
         LIMIT 1`
      )
      .get(event.id, member.family_id);
  }
  if (reuseCharge) return reuseCharge.charge_id;
  return createCharge(member.id, accountId, 'event_registration', event.id, `${event.title} - event registration`, event.price_cents, tx);
}

// { ok: false, error } or { ok: true, notice, status, waitlistPosition }
async function registerForEvent({ eventId, memberId, accountId, family }) {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: 'That event no longer exists.' };
  if (event.status !== 'published') return { ok: false, error: 'That event is not open for registration.' };
  if (!(await isRegistrationWindowOpen(event))) return { ok: false, error: 'Registration is not open for that event right now.' };

  const member = family.find((m) => m.id === memberId);
  if (!member) return { ok: false, error: 'You can only register yourself or your own family.' };
  if (memberIsAdult(member) && !event.allow_adult_register) return { ok: false, error: 'Adults cannot register for that event.' };
  if (!memberIsAdult(member) && !event.allow_child_register) return { ok: false, error: 'Kids cannot register for that event.' };
  if (!ageGroupAllowsMember(event, member)) return { ok: false, error: `That event is limited to specific grades - ${member.name}'s grade isn't included.` };

  const restriction = await eventSectionIds(eventId);
  if (restriction.length && !memberSatisfiesRestriction(await sectionIdsForMember(memberId), restriction)) {
    return { ok: false, error: 'That event is limited to specific sections you are not part of.' };
  }

  const existing = await db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status != 'cancelled'").get(eventId, memberId);
  if (existing) return { ok: false, error: `${member.name} is already registered for that event.` };

  const confirmedCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(eventId)).c);
  const familyCount = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(DISTINCT COALESCE(m.family_id, -m.id)) AS c FROM event_registrations er
           JOIN members m ON m.id = er.member_id
           WHERE er.event_id = ? AND er.status = 'confirmed' AND COALESCE(m.family_id, -m.id) != ?`
        )
        .get(eventId, member.family_id ?? -member.id)
    ).c
  );
  const overCapacity = event.capacity != null && confirmedCount >= event.capacity;
  // A family cap only blocks a *new* family from registering, once
  // event.family_capacity families already have someone confirmed - a
  // second (or third) member of a family that's already in doesn't count
  // as a new family, so they're never blocked by this cap on their own.
  const alreadyInFamily = await db
    .prepare(
      `SELECT 1 FROM event_registrations er JOIN members m ON m.id = er.member_id
       WHERE er.event_id = ? AND er.status = 'confirmed' AND COALESCE(m.family_id, -m.id) = ?`
    )
    .get(eventId, member.family_id ?? -member.id);
  const overFamilyCapacity = event.family_capacity != null && !alreadyInFamily && familyCount >= event.family_capacity;

  const isFull = overCapacity || overFamilyCapacity;
  const status = isFull ? 'waitlisted' : 'confirmed';
  let waitlistPosition = null;
  let chargeId = null;

  const previouslyCancelled = await db.prepare("SELECT id FROM event_registrations WHERE event_id = ? AND member_id = ? AND status = 'cancelled'").get(eventId, memberId);

  await db.withTransaction(async (tx) => {
    if (status === 'confirmed') {
      chargeId = await chargeForConfirmedRegistration(tx, event, member, accountId);
    } else {
      const existingWaitlisted = Number((await tx.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'waitlisted'").get(eventId)).c);
      waitlistPosition = existingWaitlisted + 1;
    }

    if (previouslyCancelled) {
      await tx
        .prepare(
          `UPDATE event_registrations SET status = ?, registered_by_account_id = ?, created_at = now_text(), cancelled_at = NULL,
             waitlist_position = ?, charge_id = ?, checked_in_at = NULL, checked_out_at = NULL WHERE id = ?`
        )
        .run(status, accountId, waitlistPosition, chargeId, previouslyCancelled.id);
    } else {
      await tx
        .prepare('INSERT INTO event_registrations (event_id, member_id, registered_by_account_id, status, waitlist_position, charge_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(eventId, memberId, accountId, status, waitlistPosition, chargeId);
    }
  });

  const notice =
    status === 'confirmed'
      ? `${member.name} is registered for "${event.title}".`
      : `${event.title} is full - ${member.name} has been added to the waitlist (#${waitlistPosition}).`;
  return { ok: true, notice, status, waitlistPosition };
}

// Settles a cancelled registration's own charge - same policy as
// classRegistration.js's own settleChargeOnCancel: nothing paid yet
// clears the charge outright, something already paid only refunds if
// there's an admin opt-in (events have no per-event auto-refund toggle
// the way classes do, since the "bookkeeping only" pricing model this
// whole feature set agreed to keep events simpler - an unpaid charge
// always clears, a paid one is always left for a Main Admin to refund by
// hand).
async function settleChargeOnCancel(chargeId) {
  if (!chargeId) return;
  const paid = await amountPaidForCharge(chargeId);
  if (paid <= 0) await cancelCharge(chargeId);
}

// Promotes the earliest-waitlisted registration (a seat just opened up)
// and shifts every waitlisted registration behind it up by one position.
// Returns who to notify rather than notifying directly - notify() would
// deadlock PGlite's single test connection if called from inside this
// open transaction (see classRegistration.js's own promoteNextWaitlisted
// for the same reasoning), so the caller notifies once committed.
async function promoteNextWaitlisted(tx, eventId) {
  const next = await tx.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND status = 'waitlisted' ORDER BY waitlist_position ASC LIMIT 1").get(eventId);
  if (!next) return null;

  const event = await tx.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const member = await tx.prepare('SELECT * FROM members WHERE id = ?').get(next.member_id);
  const chargeId = await chargeForConfirmedRegistration(tx, event, member, next.registered_by_account_id);

  await tx.prepare("UPDATE event_registrations SET status = 'confirmed', waitlist_position = NULL, charge_id = ? WHERE id = ?").run(chargeId, next.id);
  await tx
    .prepare("UPDATE event_registrations SET waitlist_position = waitlist_position - 1 WHERE event_id = ? AND status = 'waitlisted' AND waitlist_position > ?")
    .run(eventId, next.waitlist_position);

  return { accountId: next.registered_by_account_id, memberName: member.name, eventTitle: event.title };
}

async function cancelRegistration(eventId, memberId) {
  const registration = await db
    .prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status IN ('confirmed', 'waitlisted') ORDER BY id DESC LIMIT 1")
    .get(eventId, memberId);

  let promoted = null;
  await db.withTransaction(async (tx) => {
    await tx.prepare("UPDATE event_registrations SET status = 'cancelled', cancelled_at = now_text() WHERE event_id = ? AND member_id = ? AND status IN ('confirmed', 'waitlisted')").run(eventId, memberId);

    if (registration && registration.status === 'waitlisted' && registration.waitlist_position != null) {
      await tx
        .prepare("UPDATE event_registrations SET waitlist_position = waitlist_position - 1 WHERE event_id = ? AND status = 'waitlisted' AND waitlist_position > ?")
        .run(eventId, registration.waitlist_position);
    }
    if (registration && registration.status === 'confirmed') {
      promoted = await promoteNextWaitlisted(tx, eventId);
    }
  });

  if (registration && registration.charge_id) await settleChargeOnCancel(registration.charge_id);

  if (promoted) {
    await notifications.notify(promoted.accountId, 'event_waitlist_promoted', {
      title: `Off the waitlist: ${promoted.eventTitle}`,
      body: `A spot opened up - ${promoted.memberName} is now confirmed for "${promoted.eventTitle}".`,
      linkUrl: '/events/' + eventId,
    });
  }
}

// --- Guest registration (admin permission - no members row) ---

async function addGuestRegistration(eventId, { guestName, guestEmail, guestPhone }, accountId) {
  const info = await db
    .prepare('INSERT INTO event_guest_registrations (event_id, guest_name, guest_email, guest_phone, registered_by_account_id) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, guestName, guestEmail || null, guestPhone || null, accountId);
  return info.lastInsertRowid;
}

async function cancelGuestRegistration(guestRegistrationId) {
  await db.prepare("UPDATE event_guest_registrations SET status = 'cancelled' WHERE id = ?").run(guestRegistrationId);
}

// --- Check-in / check-out (name tag barcode scan, or manual P/A) ---

// Toggles the given registration/guest row directly by its own id (the
// roster page's manual Present/Absent controls, mirroring the rest of
// this app's own attendance-grid pattern) - `present: true` stamps
// checked_in_at (clearing checked_out_at, same "checking in again resets
// checkout" leniency the class scan flow has), `present: false` clears
// both.
async function setRegistrationCheckedIn(registrationId, present) {
  if (present) {
    await db.prepare("UPDATE event_registrations SET checked_in_at = now_text(), checked_out_at = NULL WHERE id = ?").run(registrationId);
  } else {
    await db.prepare('UPDATE event_registrations SET checked_in_at = NULL, checked_out_at = NULL WHERE id = ?').run(registrationId);
  }
}

async function setGuestCheckedIn(guestRegistrationId, present) {
  if (present) {
    await db.prepare("UPDATE event_guest_registrations SET checked_in_at = now_text(), checked_out_at = NULL WHERE id = ?").run(guestRegistrationId);
  } else {
    await db.prepare('UPDATE event_guest_registrations SET checked_in_at = NULL, checked_out_at = NULL WHERE id = ?').run(guestRegistrationId);
  }
}

// --- Volunteer roles (handoff item 2) ---

async function addVolunteerRole(eventId, data) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_volunteer_roles WHERE event_id = ?').get(eventId)).p) + 1;
  await db
    .prepare('INSERT INTO event_volunteer_roles (event_id, role_name, slots_needed, time_label, location, description, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, data.roleName, data.slotsNeeded || 1, data.timeLabel || null, data.location || null, data.description || null, position);
}

async function updateVolunteerRole(roleId, data) {
  await db
    .prepare('UPDATE event_volunteer_roles SET role_name = ?, slots_needed = ?, time_label = ?, location = ?, description = ? WHERE id = ?')
    .run(data.roleName, data.slotsNeeded || 1, data.timeLabel || null, data.location || null, data.description || null, roleId);
}

async function deleteVolunteerRole(roleId) {
  await db.prepare('DELETE FROM event_volunteer_roles WHERE id = ?').run(roleId);
}

// Signs memberId up for a volunteer role if a slot is actually still
// open - re-checked here server-side (never trusting the "remaining"
// count a client last saw), same "the backend is the source of truth"
// principle the rest of this app already follows (see e.g. utils/
// training.js). Returns true on success, false if the role is already
// full or memberId already signed up for it.
async function signUpForVolunteerRole(roleId, memberId, accountId) {
  const role = await db.prepare('SELECT * FROM event_volunteer_roles WHERE id = ?').get(roleId);
  if (!role) return false;
  const already = await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, memberId);
  if (already) return false;
  const filled = Number((await db.prepare('SELECT COUNT(*) AS c FROM event_volunteer_signups WHERE volunteer_role_id = ?').get(roleId)).c);
  if (filled >= role.slots_needed) return false;
  await db.prepare('INSERT INTO event_volunteer_signups (volunteer_role_id, member_id, signed_up_by_account_id) VALUES (?, ?, ?)').run(roleId, memberId, accountId);
  return true;
}

async function cancelVolunteerSignup(roleId, memberId) {
  await db.prepare('DELETE FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').run(roleId, memberId);
}

// --- Donation items (handoff item 3) ---

async function addDonationItem(eventId, data) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_donation_items WHERE event_id = ?').get(eventId)).p) + 1;
  await db
    .prepare('INSERT INTO event_donation_items (event_id, item_name, quantity_needed, deadline, notes, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(eventId, data.itemName, data.quantityNeeded || 1, data.deadline || null, data.notes || null, position);
}

async function updateDonationItem(itemId, data) {
  await db
    .prepare('UPDATE event_donation_items SET item_name = ?, quantity_needed = ?, deadline = ?, notes = ? WHERE id = ?')
    .run(data.itemName, data.quantityNeeded || 1, data.deadline || null, data.notes || null, itemId);
}

async function deleteDonationItem(itemId) {
  await db.prepare('DELETE FROM event_donation_items WHERE id = ?').run(itemId);
}

// Claims up to whatever's still actually needed - re-derived from real
// claims server-side (same reasoning as signUpForVolunteerRole above),
// clamped rather than rejected outright so a member offering "5" against
// only 2 remaining still gets recorded for the 2 that are real instead
// of failing the whole claim. Returns the quantity actually recorded (0
// if nothing was left to claim).
async function claimDonationItem(itemId, memberId, quantity, accountId) {
  const item = await db.prepare('SELECT * FROM event_donation_items WHERE id = ?').get(itemId);
  if (!item) return 0;
  const claimedSoFar = Number((await db.prepare('SELECT COALESCE(SUM(quantity_claimed), 0) AS q FROM event_donation_claims WHERE donation_item_id = ?').get(itemId)).q);
  const remaining = Math.max(0, item.quantity_needed - claimedSoFar);
  const toClaim = Math.min(remaining, Math.max(1, Number(quantity) || 1));
  if (toClaim <= 0) return 0;
  await db.prepare('INSERT INTO event_donation_claims (donation_item_id, member_id, quantity_claimed, claimed_by_account_id) VALUES (?, ?, ?, ?)').run(itemId, memberId, toClaim, accountId);
  return toClaim;
}

async function cancelDonationClaim(claimId, memberId) {
  await db.prepare('DELETE FROM event_donation_claims WHERE id = ? AND member_id = ?').run(claimId, memberId);
}

// Builds a plain Sunday-first month grid (an array of weeks, each an
// array of {date, inMonth, events} day cells) for a calendar view -
// shared by the member-facing /events?view=calendar (routes/events.js)
// and Main Admin's own Events > Calendar tab (routes/admin-events.js;
// "Main Admin Events: Calendar/Drafts/Requests/Attendance/Archive/
// Settings tabs" - a real request), kept here rather than duplicated in
// either route file - same "the view only displays, the route computes"
// split as every other page in this app.
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

module.exports = {
  GRADE_OPTIONS,
  EVENT_TYPES,
  LANGUAGES,
  monthGrid,
  sortByLastNameField,
  parseAgeGroupList,
  memberIsAdult,
  registrationWindowStatus,
  isRegistrationWindowOpen,
  listEvents,
  getEvent,
  registrationCountForEvent,
  getEventWithDetails,
  createEvent,
  updateEvent,
  setEventSections,
  setEventStatus,
  setEventImage,
  deleteEvent,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  submitEvent,
  decideSubmission,
  eventVisibleToFamily,
  registerForEvent,
  cancelRegistration,
  registrationsForEvent,
  addGuestRegistration,
  cancelGuestRegistration,
  setRegistrationCheckedIn,
  setGuestCheckedIn,
  addVolunteerRole,
  updateVolunteerRole,
  deleteVolunteerRole,
  signUpForVolunteerRole,
  cancelVolunteerSignup,
  addDonationItem,
  updateDonationItem,
  deleteDonationItem,
  claimDonationItem,
  cancelDonationClaim,
};
