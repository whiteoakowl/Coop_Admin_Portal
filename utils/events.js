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
const { toCsvRow } = require('./spreadsheet');
const { findMemberByBarcodeOrName } = require('./memberLookup');
const { ageFromBirthday } = require('./emailComposer');

// A real request: "ages should have all ages listed, not just age
// groups. 0-100." Deliberately its own list, not utils/emailComposer.js's
// AGE_GROUPS (5 coarse buckets like "5 to 8") - that one's built for
// picking a broad mass-email audience, while locking event registration
// genuinely cares about someone's exact age (e.g. "must be 8 to ride
// this"). Values are the ages themselves as strings, same "the option's
// own value/label" shape GRADE_OPTIONS already uses.
const AGE_OPTIONS = Array.from({ length: 101 }, (_, age) => String(age));

// The Create New Event wizard's own Event Type dropdown - a fixed, short
// list is plenty for a single co-op (unlike GRADE_OPTIONS/sections,
// nothing else in the app reads this back to gate anything, it's a purely
// descriptive field shown on the event). No Language list here - a real
// request: "no language option" (events.language itself is left in
// place, unused, same as every other retired-but-not-dropped column).
const EVENT_TYPES = ['In-Person', 'Virtual', 'Hybrid'];

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

// A real request: "grade level multiple choice... check boxes next to
// both that say lock registration to age level or lock registration to
// grade level" - an explicit on/off switch, rather than "did anyone check
// a grade box" alone deciding whether the restriction applies.
function ageGroupAllowsMember(event, member) {
  if (!event.lock_registration_to_grade) return true;
  const allowed = parseAgeGroupList(event.age_group);
  if (allowed.length === 0) return true;
  return allowed.includes(member.grade_level);
}

// Same shape as ageGroupAllowsMember, for the parallel age restriction -
// checks the member's own exact age (AGE_OPTIONS above), not one of
// emailComposer.js's coarser AGE_GROUPS buckets.
function ageBucketAllowsMember(event, member) {
  if (!event.lock_registration_to_age) return true;
  const allowed = parseAgeGroupList(event.age_group_restriction);
  if (allowed.length === 0) return true;
  const age = ageFromBirthday(member.birthday);
  return age != null && allowed.includes(String(age));
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
    const statuses = Array.isArray(status) ? status : [status];
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
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
  return db
    .prepare(
      `SELECT e.*, ec.name AS "categoryName", ec.color AS "categoryColor", el.name AS "locationName"
       FROM events e
       LEFT JOIN event_categories ec ON ec.id = e.category_id
       LEFT JOIN event_locations el ON el.id = e.location_id
       ${where} ORDER BY starts_at`
    )
    .all(...params);
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
    .prepare(
      `SELECT e.*, ec.name AS "categoryName", ec.color AS "categoryColor", el.name AS "locationName"
       FROM events e
       LEFT JOIN event_categories ec ON ec.id = e.category_id
       LEFT JOIN event_locations el ON el.id = e.location_id
       WHERE e.id = ?`
    )
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

  const foodItems = await db.prepare('SELECT * FROM event_food_items WHERE event_id = ? ORDER BY position, id').all(id);
  for (const item of foodItems) {
    item.claims = sortByLastNameField(
      await db
        .prepare(
          `SELECT efc.*, m.name AS "memberName" FROM event_food_claims efc
           JOIN members m ON m.id = efc.member_id
           WHERE efc.food_item_id = ?`
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

  const ticketTypes = await db.prepare('SELECT * FROM event_ticket_types WHERE event_id = ? ORDER BY position, id').all(id);

  return {
    ...event,
    volunteerRoles: roles,
    donationItems,
    foodItems,
    ticketTypes,
    registrationCount,
    waitlistCount,
    familyCount,
    guestRegistrations,
    sectionIds: await eventSectionIds(id),
  };
}

// --- Ticket types (Finance tab, per-person events only) - a real
// request: "if charging per person there should be an option for adding
// several types of tickets with a different price and title bar next to
// it." Same has-many-rows-owned-by-one-event shape as Volunteer Roles/
// Donation Items/Food Items above - admin-side only for now (a scoping
// question confirmed this): registration still charges the event's own
// flat price_cents, this is just for the admin to define/manage the list.
async function addTicketType(eventId, title, priceCents) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_ticket_types WHERE event_id = ?').get(eventId)).p) + 1;
  await db.prepare('INSERT INTO event_ticket_types (event_id, title, price_cents, position) VALUES (?, ?, ?, ?)').run(eventId, title, priceCents, position);
}

async function deleteTicketType(id) {
  await db.prepare('DELETE FROM event_ticket_types WHERE id = ?').run(id);
}

// --- Accounting Categories - same shape as event_categories (see
// 20260826040000_events_registration_rules.sql), a separate fixed list
// for internal bookkeeping rather than the public-facing Category
// dropdown events already have. A real request: "add a drop down menu
// for choosing accounting category."
async function listAccountingCategories() {
  return db.prepare('SELECT * FROM event_accounting_categories ORDER BY position, name').all();
}

async function createAccountingCategory(name) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_accounting_categories').get()).p) + 1;
  await db.prepare('INSERT INTO event_accounting_categories (name, position) VALUES (?, ?)').run(name, position);
}

async function updateAccountingCategory(id, name) {
  await db.prepare('UPDATE event_accounting_categories SET name = ? WHERE id = ?').run(name, id);
}

async function deleteAccountingCategory(id) {
  await db.prepare('DELETE FROM event_accounting_categories WHERE id = ?').run(id);
}

function eventFields(data) {
  return [
    data.title,
    data.description || null,
    data.category || null,
    data.categoryId ?? null,
    data.location || null,
    data.locationId ?? null,
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
    data.allowGuestRegister ? 1 : 0,
    data.priceCents ?? null,
    data.pricePer === 'family' ? 'family' : 'person',
    data.slug || null,
    data.eventType || null,
    data.shortDescription || null,
    data.language || null,
    data.organizedBy || null,
    data.tags || null,
    data.volunteersEnabled ? 1 : 0,
    data.donationsEnabled ? 1 : 0,
    data.foodEnabled ? 1 : 0,
    data.volunteerSelectionCount ?? null,
    data.donationSelectionCount ?? null,
    data.foodSelectionCount ?? null,
    data.isClosed ? 1 : 0,
    // Same "undefined must not silently override the migration's own
    // DEFAULT 1" guard volunteersEnabled/donationsEnabled already need
    // above - the Create wizard never sends this field at all.
    data.allowRegistrationCancellations === false ? 0 : 1,
    data.allowRefundOnCancel ? 1 : 0,
    data.showRegistrantsToMembers ? 1 : 0,
    data.trackParticipantsOnly ? 1 : 0,
    data.lockRegistrationToGrade ? 1 : 0,
    data.lockRegistrationToAge ? 1 : 0,
    data.ageGroupRestriction || null,
    data.lockRegistrationToSection ? 1 : 0,
    data.registrationSectionId ?? null,
    data.lockVisibilityToSection ? 1 : 0,
    data.visibilitySectionId ?? null,
    data.accountingCategoryId ?? null,
  ];
}

// status defaults to 'draft' (every pre-wizard caller, and a member's own
// submitEvent below, still create a plain draft) - the Create New Event
// wizard's own Publish Event button is the one caller that now passes
// 'published' straight through, so publishing no longer needs a separate
// save-then-status round trip. approvalStatus can also be forced (item
// 9's family-submission "Automatically Approve" setting) rather than
// derived from submittedByAccountId alone.
async function createEvent(data, accountId, { submittedByAccountId = null, status = 'draft', approvalStatus: forcedApprovalStatus = null } = {}) {
  const approvalStatus = forcedApprovalStatus || (submittedByAccountId ? 'pending' : 'approved');
  const info = await db
    .prepare(
      `INSERT INTO events (
         title, description, category, category_id, location, location_id, starts_at, ends_at, visibility, capacity,
         family_capacity, age_group, registration_opens_at, registration_closes_at,
         allow_adult_register, allow_child_register, allow_guest_register, price_cents, price_per,
         slug, event_type, short_description, language, organized_by, tags,
         volunteers_enabled, donations_enabled, food_enabled,
         volunteer_selection_count, donation_selection_count, food_selection_count,
         is_closed, allow_registration_cancellations, allow_refund_on_cancel, show_registrants_to_members, track_participants_only,
         lock_registration_to_grade, lock_registration_to_age, age_group_restriction,
         lock_registration_to_section, registration_section_id, lock_visibility_to_section, visibility_section_id, accounting_category_id,
         created_by_account_id, submitted_by_account_id, approval_status, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...eventFields(data), accountId, submittedByAccountId, approvalStatus, status);
  return info.lastInsertRowid;
}

async function updateEvent(id, data) {
  await db
    .prepare(
      `UPDATE events SET
         title = ?, description = ?, category = ?, category_id = ?, location = ?, location_id = ?, starts_at = ?, ends_at = ?, visibility = ?, capacity = ?,
         family_capacity = ?, age_group = ?, registration_opens_at = ?, registration_closes_at = ?,
         allow_adult_register = ?, allow_child_register = ?, allow_guest_register = ?, price_cents = ?, price_per = ?,
         slug = ?, event_type = ?, short_description = ?, language = ?, organized_by = ?, tags = ?,
         volunteers_enabled = ?, donations_enabled = ?, food_enabled = ?,
         volunteer_selection_count = ?, donation_selection_count = ?, food_selection_count = ?,
         is_closed = ?, allow_registration_cancellations = ?, allow_refund_on_cancel = ?, show_registrants_to_members = ?, track_participants_only = ?,
         lock_registration_to_grade = ?, lock_registration_to_age = ?, age_group_restriction = ?,
         lock_registration_to_section = ?, registration_section_id = ?, lock_visibility_to_section = ?, visibility_section_id = ?, accounting_category_id = ?,
         updated_at = now_text()
       WHERE id = ?`
    )
    .run(...eventFields(data), id);
}

// Item 11's title-click quick-edit popup only exposes the same fields the
// New Event popup does (title/description/location/dates/category/
// visibility/capacity) - a real, deliberately partial UPDATE rather than
// reusing updateEvent()'s full column list above, because updateEvent()
// always writes every registration-rule column (family cap, age group,
// registration window, adult/child gating, price) and calls
// setEventSections() right after - both would silently wipe out whatever
// the Builder's own Registration Rules/Sections panels already set,
// every time someone fixed a typo in the title from this quick popup.
async function updateEventQuickFields(id, data) {
  await db
    .prepare(
      `UPDATE events SET
         title = ?, description = ?, location_id = ?, starts_at = ?, ends_at = ?, category_id = ?, visibility = ?, capacity = ?,
         updated_at = now_text()
       WHERE id = ?`
    )
    .run(
      data.title,
      data.description || null,
      data.locationId ?? null,
      data.startsAt,
      data.endsAt || null,
      data.categoryId ?? null,
      data.visibility === 'public' ? 'public' : 'members',
      data.capacity ?? null,
      id
    );
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

async function createCategory(name, color, allowSync) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_categories').get()).p) + 1;
  await db.prepare('INSERT INTO event_categories (name, color, position, allow_sync) VALUES (?, ?, ?, ?)').run(name, color || '#EE9A4D', position, allowSync ? 1 : 0);
}

async function updateCategory(id, name, color, allowSync) {
  await db.prepare('UPDATE event_categories SET name = ?, color = ?, allow_sync = ? WHERE id = ?').run(name, color || '#EE9A4D', allowSync ? 1 : 0, id);
}

async function deleteCategory(id) {
  await db.prepare('DELETE FROM event_categories WHERE id = ?').run(id);
}

// --- Locations (item 8) - same shape as Categories above ---

async function listLocations() {
  return db.prepare('SELECT * FROM event_locations ORDER BY position, name').all();
}

async function createLocation(name, address) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_locations').get()).p) + 1;
  await db.prepare('INSERT INTO event_locations (name, address, position) VALUES (?, ?, ?)').run(name, address || null, position);
}

async function updateLocation(id, name, address) {
  await db.prepare('UPDATE event_locations SET name = ?, address = ? WHERE id = ?').run(name, address || null, id);
}

async function deleteLocation(id) {
  await db.prepare('DELETE FROM event_locations WHERE id = ?').run(id);
}

// --- Settings (item 9) - one singleton row, same shape/reasoning as
// site_settings; see the migration header comment for which fields are
// actually wired to live behavior vs. stored for a system that doesn't
// exist yet in this app. ---

async function getEventSettings() {
  return db.prepare('SELECT * FROM event_settings WHERE id = 1').get();
}

async function updateEventSettings(data) {
  await db
    .prepare(
      `UPDATE event_settings SET
        default_calendar_view = ?, show_waitlist_position = ?, reminder_days_before = ?,
        credit_on_family_cancel = ?, credit_on_admin_cancel = ?, auto_refund_on_family_cancel = ?,
        subadmin_edit_locations = ?, subadmin_edit_categories = ?,
        family_submit_events = ?, submit_notification_email = ?,
        family_manage_price_options = ?, family_manage_own_events = ?,
        updated_at = now_text()
      WHERE id = 1`
    )
    .run(
      data.defaultCalendarView === 'list' ? 'list' : 'calendar',
      data.showWaitlistPosition ? 1 : 0,
      Number(data.reminderDaysBefore) || 0,
      data.creditOnFamilyCancel ? 1 : 0,
      data.creditOnAdminCancel ? 1 : 0,
      data.autoRefundOnFamilyCancel ? 1 : 0,
      data.subadminEditLocations ? 1 : 0,
      data.subadminEditCategories ? 1 : 0,
      ['yes', 'auto_approve', 'no'].includes(data.familySubmitEvents) ? data.familySubmitEvents : 'yes',
      (data.submitNotificationEmail || '').trim() || null,
      data.familyManagePriceOptions ? 1 : 0,
      data.familyManageOwnEvents ? 1 : 0
    );
}

// --- Member-submitted events, awaiting Main Admin approval ---

// A member submitting an event is really just createEvent with
// submittedByAccountId set - approval_status starts 'pending' and the
// event starts 'draft' either way, so a pending submission never shows
// up anywhere but the submitter's own "my submissions" and the Main
// Admin approval queue until it's actually decided. Settings-gated per
// item 9's "Allow families to submit calendar of events items?" (Yes /
// Automatically Approve / No). A later real request removed the
// "Make events submitted by families public by default?" override that
// used to live here - a submitted event now always keeps whatever
// visibility the submitter picked.
async function submitEvent(data, accountId) {
  const settings = await getEventSettings();
  if (settings.family_submit_events === 'no') return null;
  return createEvent(
    data,
    accountId,
    settings.family_submit_events === 'auto_approve'
      ? { submittedByAccountId: accountId, approvalStatus: 'approved' }
      : { submittedByAccountId: accountId }
  );
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
  const union = new Set();
  for (const member of family) {
    for (const id of await sectionIdsForMember(member.id)) union.add(id);
  }
  if (restriction.length > 0 && !memberSatisfiesRestriction(union, restriction)) return false;

  // A real request: "lock registration to only be viewable to one
  // section check box and dropdown" - a second, narrower single-section
  // gate alongside the existing multi-section restriction above; a
  // family must satisfy both when both apply.
  const event = await getEvent(eventId);
  if (event && event.lock_visibility_to_section && event.visibility_section_id && !union.has(event.visibility_section_id)) {
    return false;
  }
  return true;
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

// A real request: "roster will show primary member name sub categories
// students and other guests in that family." Groups registrationsForEvent's
// flat per-member rows (plus this event's own guest registrations, tied
// back to a family through whichever account registered them) by family -
// a member/guest with no family at all gets its own singleton group, same
// "empty means standalone" convention the rest of this app uses. Each
// group's own members sort primary parent first (then alphabetical), so
// the admin-events-registrations.ejs roster can render that member as the
// group's own "primary" row and every other member/guest in the group as
// an indented line under it; groups themselves sort by that primary row's
// own last name, same order registrationsForEvent already used.
async function familyGroupedRegistrationsForEvent(eventId) {
  const registrations = await db
    .prepare(
      `SELECT er.*, m.name AS "memberName", m.member_code AS "memberCode", m.family_id AS "familyId", m.is_primary_parent AS "isPrimaryParent", m.member_type AS "memberType"
       FROM event_registrations er
       JOIN members m ON m.id = er.member_id
       WHERE er.event_id = ?`
    )
    .all(eventId);
  const guestRegistrations = await db
    .prepare(
      `SELECT g.*, m.family_id AS "familyId"
       FROM event_guest_registrations g
       LEFT JOIN member_accounts ma ON ma.id = g.registered_by_account_id
       LEFT JOIN members m ON m.id = ma.member_id
       WHERE g.event_id = ? AND g.status != 'cancelled'`
    )
    .all(eventId);

  const groups = new Map();
  function groupFor(familyId, soloKey) {
    const key = familyId != null ? `family:${familyId}` : `solo:${soloKey}`;
    if (!groups.has(key)) groups.set(key, { members: [], guests: [] });
    return groups.get(key);
  }
  registrations.forEach((r) => groupFor(r.familyId, `member:${r.member_id}`).members.push(r));
  guestRegistrations.forEach((g) => groupFor(g.familyId, `guest:${g.id}`).guests.push(g));

  const groupList = Array.from(groups.values());
  groupList.forEach((group) => {
    group.members.sort((a, b) => {
      const primaryDiff = (b.isPrimaryParent ? 1 : 0) - (a.isPrimaryParent ? 1 : 0);
      if (primaryDiff) return primaryDiff;
      return a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' });
    });
    group.guests.sort((a, b) => a.guest_name.localeCompare(b.guest_name, undefined, { sensitivity: 'base' }));
  });
  groupList.sort((a, b) => {
    const aName = a.members[0] ? a.members[0].memberName : a.guests[0].guest_name;
    const bName = b.members[0] ? b.members[0].memberName : b.guests[0].guest_name;
    return lastNameOf(aName).localeCompare(lastNameOf(bName), undefined, { sensitivity: 'base' }) || aName.localeCompare(bName, undefined, { sensitivity: 'base' });
  });
  return groupList;
}

// "Add Registration" popup's own member checklist (a real request: "pop
// up with menu of members with check boxes and filter for family name in
// ABC order") - every active member not already registered (a cancelled
// registration doesn't count as "already registered" here, same as
// createOrReactivateRegistration's own reuse-the-cancelled-row logic),
// sorted by family surname then name so the family filter/list reads in
// the same A-Z order either way.
async function eligibleMembersForRegistration(eventId) {
  const rows = await db
    .prepare(
      `SELECT m.id, m.name, m.member_type AS "memberType", f.name AS "familyName"
       FROM members m
       LEFT JOIN families f ON f.id = m.family_id
       WHERE m.active = 1
         AND m.id NOT IN (SELECT member_id FROM event_registrations WHERE event_id = ? AND status != 'cancelled')
       ORDER BY LOWER(COALESCE(f.name, m.name)), LOWER(m.name)`
    )
    .all(eventId);
  return rows;
}

// A real request: "add import and export button as well" (on the
// Registrations page). Export flattens familyGroupedRegistrationsForEvent's
// own shape - already sorted family-first, A-Z by family surname - into
// one row per member/guest, same order the on-screen roster and the
// print view use.
const REGISTRATION_EXPORT_HEADER = ['Family', 'Name', 'Status', 'Paid', 'Registered At', 'P/A/L', 'Checked In', 'Checked Out', 'Volunteer Signup'];

function buildRegistrationsExportCsvLines(event, familyGroups, volunteerSignupsByMember) {
  const lines = [toCsvRow(REGISTRATION_EXPORT_HEADER)];
  function priceFor(status, isFirstInGroup) {
    if (event.price_cents == null || status !== 'confirmed') return '';
    if (event.price_per === 'family' && !isFirstInGroup) return '';
    return (event.price_cents / 100).toFixed(2);
  }
  familyGroups.forEach((group) => {
    const familyLabel = group.members[0] ? lastNameOf(group.members[0].memberName) : lastNameOf(group.guests[0].guest_name);
    let isFirst = true;
    group.members.forEach((r) => {
      lines.push(
        toCsvRow([
          familyLabel,
          r.memberName,
          r.status,
          priceFor(r.status, isFirst),
          r.created_at,
          r.attendance_status || '',
          r.checked_in_at || '',
          r.checked_out_at || '',
          (volunteerSignupsByMember.get(r.member_id) || []).join('; '),
        ])
      );
      isFirst = false;
    });
    group.guests.forEach((g) => {
      lines.push(toCsvRow([familyLabel, `${g.guest_name} (Guest)`, g.status, priceFor(g.status, isFirst), g.created_at, g.attendance_status || '', g.checked_in_at || '', g.checked_out_at || '', '']));
      isFirst = false;
    });
  });
  return lines;
}

// Import counterpart - a spreadsheet with a "Member Code or Name" column
// (barcode also accepted, same lookup the Check-In scan endpoint already
// uses) is the bulk alternative to the Add Registration popup's own
// checkbox list, for a family emailed in ahead of time rather than
// clicked through one at a time.
async function importRegistrationsFromRows(eventId, rows, accountId) {
  const errors = [];
  const found = []; // { rowNum, memberId }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const raw = String(row['Member Code or Name'] || row['Member Code'] || row['Name'] || row['member code or name'] || '').trim();
    if (!raw) {
      errors.push(`Row ${rowNum}: needs a Member Code or Name.`);
      continue;
    }
    const { member, ambiguous } = await findMemberByBarcodeOrName(raw);
    if (ambiguous) {
      errors.push(`Row ${rowNum}: "${raw}" matches more than one member - use their member code instead.`);
      continue;
    }
    if (!member) {
      errors.push(`Row ${rowNum}: no active member matches "${raw}".`);
      continue;
    }
    found.push({ rowNum, memberId: member.id });
  }
  const results = found.length ? await adminAddRegistrations(eventId, found.map((f) => f.memberId), accountId) : [];
  let imported = 0;
  results.forEach((r, i) => {
    if (r.ok) imported += 1;
    else errors.push(`Row ${found[i].rowNum}: ${r.error}`);
  });
  return { imported, errors };
}

// Volunteer signup(s) per member for this event, if the event has
// volunteering enabled at all - a plain memberId -> [roleName, ...] map,
// for the roster's own "Volunteer Signup" column (a real request: "then a
// column for volunteer signup"). Reuses the same event_volunteer_signups/
// event_volunteer_roles tables getEventWithDetails already joins for the
// member-facing Volunteer section, just shaped for a lookup instead of a
// per-role list of signups.
async function volunteerSignupsByMemberForEvent(eventId) {
  const rows = await db
    .prepare(
      `SELECT evs.member_id AS "memberId", evr.role_name AS "roleName" FROM event_volunteer_signups evs
       JOIN event_volunteer_roles evr ON evr.id = evs.volunteer_role_id
       WHERE evr.event_id = ?`
    )
    .all(eventId);
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.memberId)) map.set(r.memberId, []);
    map.get(r.memberId).push(r.roleName);
  });
  return map;
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

// Shared by registerForEvent (below, member self-service, full eligibility
// rules) and adminAddRegistrations (a real request: "add a button that
// says add registration... select multiple boxes and save all at once" -
// a Main Admin registering someone on purpose overrides age/section/family-
// ownership eligibility, but still has to respect the same capacity/
// waitlist/charge bookkeeping every registration goes through, or a
// capacity event could be oversold by whichever path an admin happened to
// use). Assumes the caller already confirmed the event exists/is a real
// target - only "already registered" is re-checked here since it's cheap
// and both callers need it.
async function createOrReactivateRegistration(event, member, accountId) {
  const existing = await db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status != 'cancelled'").get(event.id, member.id);
  if (existing) return { ok: false, error: `${member.name} is already registered for that event.` };

  const confirmedCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(event.id)).c);
  const familyCount = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(DISTINCT COALESCE(m.family_id, -m.id)) AS c FROM event_registrations er
           JOIN members m ON m.id = er.member_id
           WHERE er.event_id = ? AND er.status = 'confirmed' AND COALESCE(m.family_id, -m.id) != ?`
        )
        .get(event.id, member.family_id ?? -member.id)
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
    .get(event.id, member.family_id ?? -member.id);
  const overFamilyCapacity = event.family_capacity != null && !alreadyInFamily && familyCount >= event.family_capacity;

  const isFull = overCapacity || overFamilyCapacity;
  const status = isFull ? 'waitlisted' : 'confirmed';
  let waitlistPosition = null;
  let chargeId = null;

  const previouslyCancelled = await db.prepare("SELECT id FROM event_registrations WHERE event_id = ? AND member_id = ? AND status = 'cancelled'").get(event.id, member.id);

  await db.withTransaction(async (tx) => {
    if (status === 'confirmed') {
      chargeId = await chargeForConfirmedRegistration(tx, event, member, accountId);
    } else {
      const existingWaitlisted = Number((await tx.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'waitlisted'").get(event.id)).c);
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
        .run(event.id, member.id, accountId, status, waitlistPosition, chargeId);
    }
  });

  const notice =
    status === 'confirmed'
      ? `${member.name} is registered for "${event.title}".`
      : `${event.title} is full - ${member.name} has been added to the waitlist (#${waitlistPosition}).`;
  return { ok: true, notice, status, waitlistPosition };
}

// { ok: false, error } or { ok: true, notice, status, waitlistPosition }
async function registerForEvent({ eventId, memberId, accountId, family }) {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: 'That event no longer exists.' };
  if (event.status !== 'published') return { ok: false, error: 'That event is not open for registration.' };
  // A real request: "close event" checkbox - a manual override
  // independent of status/capacity/registration window.
  if (event.is_closed) return { ok: false, error: 'Registration is closed for that event.' };
  if (!(await isRegistrationWindowOpen(event))) return { ok: false, error: 'Registration is not open for that event right now.' };

  const member = family.find((m) => m.id === memberId);
  if (!member) return { ok: false, error: 'You can only register yourself or your own family.' };
  if (memberIsAdult(member) && !event.allow_adult_register) return { ok: false, error: 'Adults cannot register for that event.' };
  if (!memberIsAdult(member) && !event.allow_child_register) return { ok: false, error: 'Kids cannot register for that event.' };
  if (!ageGroupAllowsMember(event, member)) return { ok: false, error: `That event is limited to specific grades - ${member.name}'s grade isn't included.` };
  if (!ageBucketAllowsMember(event, member)) return { ok: false, error: `That event is limited to specific ages - ${member.name}'s age isn't included.` };

  const restriction = await eventSectionIds(eventId);
  if (restriction.length && !memberSatisfiesRestriction(await sectionIdsForMember(memberId), restriction)) {
    return { ok: false, error: 'That event is limited to specific sections you are not part of.' };
  }
  // A real request: "checkbox lock registration to section, drop down of
  // sections" - a second, narrower single-section gate a member must
  // also satisfy when it's on, alongside the multi-section restriction
  // above.
  if (event.lock_registration_to_section && event.registration_section_id) {
    const memberSections = await sectionIdsForMember(memberId);
    if (!memberSections.has(event.registration_section_id)) {
      return { ok: false, error: 'That event is limited to a specific section you are not part of.' };
    }
  }

  return createOrReactivateRegistration(event, member, accountId);
}

// A real request: "add a button that says add registration. Pop up with
// menu of members with check boxes... select multiple boxes and save all
// at once." One result per requested member, in order, so the route can
// report which (if any) failed (already registered) without losing the
// ones that succeeded.
async function adminAddRegistrations(eventId, memberIds, accountId) {
  const event = await getEvent(eventId);
  if (!event) return memberIds.map(() => ({ ok: false, error: 'That event no longer exists.' }));
  const results = [];
  for (const memberId of memberIds) {
    const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!member) {
      results.push({ ok: false, error: 'That member no longer exists.' });
      continue;
    }
    results.push(await createOrReactivateRegistration(event, member, accountId));
  }
  return results;
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

// Item 11 - "a view exactly like class check in/out": distinct Check In/
// Check Out buttons (not just the single Present/Clear toggle above) and
// a P/A/L roster grid for manually correcting the status, same shape as
// utils/attendance.js's own class attendance grid.
async function setRegistrationCheckedOut(registrationId) {
  await db.prepare("UPDATE event_registrations SET checked_out_at = now_text() WHERE id = ?").run(registrationId);
}

async function setGuestCheckedOut(guestRegistrationId) {
  await db.prepare("UPDATE event_guest_registrations SET checked_out_at = now_text() WHERE id = ?").run(guestRegistrationId);
}

async function setRegistrationAttendanceStatus(registrationId, status) {
  await db.prepare('UPDATE event_registrations SET attendance_status = ? WHERE id = ?').run(status || null, registrationId);
}

async function setGuestAttendanceStatus(guestRegistrationId, status) {
  await db.prepare('UPDATE event_guest_registrations SET attendance_status = ? WHERE id = ?').run(status || null, guestRegistrationId);
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

// --- Food items - a real request: "on the volunteer, donations and food
// pages. there will be a check box for, do you want to include this
// section? then a dropdown menu of numbers 1-50..." Food is a brand new
// third section, same shape as Donation Items exactly (a potluck-style
// sign-up sheet a member claims an item on) - see that section above for
// the reasoning each of these mirrors 1:1. ---

async function addFoodItem(eventId, data) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_food_items WHERE event_id = ?').get(eventId)).p) + 1;
  await db
    .prepare('INSERT INTO event_food_items (event_id, item_name, quantity_needed, deadline, notes, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(eventId, data.itemName, data.quantityNeeded || 1, data.deadline || null, data.notes || null, position);
}

async function updateFoodItem(itemId, data) {
  await db
    .prepare('UPDATE event_food_items SET item_name = ?, quantity_needed = ?, deadline = ?, notes = ? WHERE id = ?')
    .run(data.itemName, data.quantityNeeded || 1, data.deadline || null, data.notes || null, itemId);
}

async function deleteFoodItem(itemId) {
  await db.prepare('DELETE FROM event_food_items WHERE id = ?').run(itemId);
}

async function claimFoodItem(itemId, memberId, quantity, accountId) {
  const item = await db.prepare('SELECT * FROM event_food_items WHERE id = ?').get(itemId);
  if (!item) return 0;
  const claimedSoFar = Number((await db.prepare('SELECT COALESCE(SUM(quantity_claimed), 0) AS q FROM event_food_claims WHERE food_item_id = ?').get(itemId)).q);
  const remaining = Math.max(0, item.quantity_needed - claimedSoFar);
  const toClaim = Math.min(remaining, Math.max(1, Number(quantity) || 1));
  if (toClaim <= 0) return 0;
  await db.prepare('INSERT INTO event_food_claims (food_item_id, member_id, quantity_claimed, claimed_by_account_id) VALUES (?, ?, ?, ?)').run(itemId, memberId, toClaim, accountId);
  return toClaim;
}

async function cancelFoodClaim(claimId, memberId) {
  await db.prepare('DELETE FROM event_food_claims WHERE id = ? AND member_id = ?').run(claimId, memberId);
}

// --- CSV export/import (item 5) - a real request: "needs import and
// export buttons." Datetimes round-trip as plain "YYYY-MM-DD HH:MM"
// text (the same shape <input type="datetime-local"> already produces
// everywhere else in this app, e.g. routes/admin-events.js's own
// toSqlTimestamp) - deliberately not trying to guess every locale/
// format a spreadsheet app might have serialized a date-time cell as
// the way utils/memberImport.js's own normalizeBirthdayToISO does for a
// date-only column; a date-time is much easier to get wrong two ways
// (date AND time), so the export/template both model the exact format
// the import expects instead.
const EVENT_EXPORT_HEADER = ['Title', 'Starts At', 'Ends At', 'Location', 'Category', 'Visibility', 'Capacity', 'Description'];

function buildEventsExportCsvLines(eventList) {
  const lines = [toCsvRow(EVENT_EXPORT_HEADER)];
  for (const e of eventList) {
    lines.push(
      toCsvRow([
        e.title,
        (e.starts_at || '').slice(0, 16),
        (e.ends_at || '').slice(0, 16),
        e.locationName || e.location || '',
        e.categoryName || e.category || '',
        e.visibility,
        e.capacity ?? '',
        (e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      ])
    );
  }
  return lines;
}

// "YYYY-MM-DD HH:MM" (with or without a trailing :SS, with or without a
// T instead of a space - the exact shape <input type="datetime-local">
// produces) straight into the "YYYY-MM-DD HH:MM:SS" text shape this
// app's timestamp columns use - see toSqlTimestamp in routes/admin-
// events.js, the same conversion for a real form submission.
function normalizeEventDateTime(value) {
  const trimmed = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, date, hh, mm, ss] = match;
  return `${date} ${hh}:${mm}:${ss || '00'}`;
}

// Imported events always land as unpublished drafts, regardless of what
// (if anything) a Visibility column says - same "an import never skips
// review" caution utils/resourceLinks.js's own admin-add path doesn't
// need (that one really is meant to publish immediately) but a batch of
// unfamiliar rows from a spreadsheet does; a Main Admin still reviews
// and publishes each one from the Drafts tab same as always.
async function importEventsFromRows(rows, accountId) {
  const categories = await listCategories();
  const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const locations = await listLocations();
  const locationIdByName = new Map(locations.map((l) => [l.name.toLowerCase(), l.id]));

  let imported = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // header is row 1
    const title = String(row['Title'] || row['title'] || '').trim();
    const startsRaw = row['Starts At'] || row['starts at'] || row['StartsAt'] || '';
    const startsAt = normalizeEventDateTime(startsRaw);
    if (!title || !startsAt) {
      errors.push(`Row ${rowNum}: needs a Title and a valid Starts At (YYYY-MM-DD HH:MM).`);
      continue;
    }
    const endsAt = normalizeEventDateTime(row['Ends At'] || row['ends at'] || '');
    const location = String(row['Location'] || row['location'] || '').trim();
    const categoryName = String(row['Category'] || row['category'] || '').trim();
    const visibilityRaw = String(row['Visibility'] || row['visibility'] || '').trim().toLowerCase();
    const capacityRaw = row['Capacity'] ?? row['capacity'];
    const description = String(row['Description'] || row['description'] || '').trim();

    await createEvent(
      {
        title,
        description,
        location,
        locationId: locationIdByName.get(location.toLowerCase()) || null,
        category: categoryName,
        categoryId: categoryIdByName.get(categoryName.toLowerCase()) || null,
        startsAt,
        endsAt,
        visibility: visibilityRaw === 'public' ? 'public' : 'members',
        capacity: capacityRaw ? parseInt(capacityRaw, 10) || null : null,
        pricePer: 'person',
        allowAdultRegister: true,
        allowChildRegister: true,
      },
      accountId
    );
    imported++;
  }
  return { imported, errors };
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
    year,
    month: month + 1,
    label: firstOfMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    prevParam: `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`,
    nextParam: `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

module.exports = {
  GRADE_OPTIONS,
  AGE_OPTIONS,
  EVENT_TYPES,
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
  updateEventQuickFields,
  setEventSections,
  setEventStatus,
  setEventImage,
  deleteEvent,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  addTicketType,
  deleteTicketType,
  listAccountingCategories,
  createAccountingCategory,
  updateAccountingCategory,
  deleteAccountingCategory,
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  getEventSettings,
  updateEventSettings,
  EVENT_EXPORT_HEADER,
  buildEventsExportCsvLines,
  normalizeEventDateTime,
  importEventsFromRows,
  submitEvent,
  decideSubmission,
  eventVisibleToFamily,
  registerForEvent,
  adminAddRegistrations,
  eligibleMembersForRegistration,
  cancelRegistration,
  registrationsForEvent,
  familyGroupedRegistrationsForEvent,
  buildRegistrationsExportCsvLines,
  importRegistrationsFromRows,
  volunteerSignupsByMemberForEvent,
  addGuestRegistration,
  cancelGuestRegistration,
  setRegistrationCheckedIn,
  setGuestCheckedIn,
  setRegistrationCheckedOut,
  setGuestCheckedOut,
  setRegistrationAttendanceStatus,
  setGuestAttendanceStatus,
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
  addFoodItem,
  updateFoodItem,
  deleteFoodItem,
  claimFoodItem,
  cancelFoodClaim,
};
