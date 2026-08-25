// Events (Community & Commerce track, item 1) - the backbone Volunteer
// signups (item 2) and Donation signups (item 3) hang directly off of,
// via event_volunteer_roles/event_volunteer_signups and
// event_donation_items/event_donation_claims. See supabase/migrations/
// 20260825030000_events_module.sql for the full schema and TEAM_B_
// HANDOFF.md for the feature list this implements.
//
// Registration/signup/claim all follow the same shape Track A's own
// class_registrations already established (routes/parent-portal.js): the
// person being registered is a real `members` row (so a parent can act
// for any of their own family, not just themselves), while the account
// that took the action is recorded separately for accountability.
const db = require('../db');

async function listEvents({ status, visibility, upcomingOnly } = {}) {
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
  if (upcomingOnly) clauses.push("starts_at >= now_text()");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM events ${where} ORDER BY starts_at`).all(...params);
}

async function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

// Full detail for one event page (admin management or a member's own
// view of it): the event row, its volunteer roles each with their own
// signups + filled/needed counts, its donation items each with their own
// claims + claimed/needed totals, and the event's own registration
// count. quantity_claimed is always summed live from event_donation_
// claims here, never a stored counter - see the migration's own comment
// on why.
async function getEventWithDetails(id) {
  const event = await getEvent(id);
  if (!event) return null;

  const roles = await db.prepare('SELECT * FROM event_volunteer_roles WHERE event_id = ? ORDER BY position, id').all(id);
  for (const role of roles) {
    role.signups = await db
      .prepare(
        `SELECT evs.*, m.name AS "memberName" FROM event_volunteer_signups evs
         JOIN members m ON m.id = evs.member_id
         WHERE evs.volunteer_role_id = ? ORDER BY evs.created_at`
      )
      .all(role.id);
    role.filled = role.signups.length;
    role.remaining = Math.max(0, role.slots_needed - role.filled);
  }

  const donationItems = await db.prepare('SELECT * FROM event_donation_items WHERE event_id = ? ORDER BY position, id').all(id);
  for (const item of donationItems) {
    item.claims = await db
      .prepare(
        `SELECT edc.*, m.name AS "memberName" FROM event_donation_claims edc
         JOIN members m ON m.id = edc.member_id
         WHERE edc.donation_item_id = ? ORDER BY edc.created_at`
      )
      .all(item.id);
    item.quantityClaimed = item.claims.reduce((sum, c) => sum + Number(c.quantity_claimed), 0);
    item.remaining = Math.max(0, item.quantity_needed - item.quantityClaimed);
  }

  const registrationCount = Number(
    (await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(id)).c
  );
  const waitlistCount = Number(
    (await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'waitlisted'").get(id)).c
  );

  return { ...event, volunteerRoles: roles, donationItems, registrationCount, waitlistCount };
}

async function createEvent(data, accountId) {
  const info = await db
    .prepare(
      `INSERT INTO events (title, description, category, location, starts_at, ends_at, visibility, capacity, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(data.title, data.description || null, data.category || null, data.location || null, data.startsAt, data.endsAt || null, data.visibility, data.capacity ?? null, accountId);
  return info.lastInsertRowid;
}

async function updateEvent(id, data) {
  await db
    .prepare(
      `UPDATE events SET title = ?, description = ?, category = ?, location = ?, starts_at = ?, ends_at = ?, visibility = ?, capacity = ?, updated_at = now_text()
       WHERE id = ?`
    )
    .run(data.title, data.description || null, data.category || null, data.location || null, data.startsAt, data.endsAt || null, data.visibility, data.capacity ?? null, id);
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

// Registers memberId for eventId - confirmed if there's room (or no
// capacity set at all), waitlisted otherwise, same capacity/waitlist
// shape as parent-portal.js's own class registration. Returns the
// resulting status, or 'already' if memberId already has a non-cancelled
// registration (re-registering after a cancellation is allowed - it just
// re-runs the same capacity check fresh).
async function registerForEvent(eventId, memberId, accountId) {
  const existing = await db
    .prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status != 'cancelled'")
    .get(eventId, memberId);
  if (existing) return existing.status;

  const event = await getEvent(eventId);
  if (!event) return null;
  const confirmedCount = Number(
    (await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(eventId)).c
  );
  const isFull = event.capacity != null && confirmedCount >= event.capacity;
  const status = isFull ? 'waitlisted' : 'confirmed';

  const previouslyCancelled = await db.prepare("SELECT id FROM event_registrations WHERE event_id = ? AND member_id = ? AND status = 'cancelled'").get(eventId, memberId);
  if (previouslyCancelled) {
    await db.prepare('UPDATE event_registrations SET status = ?, registered_by_account_id = ?, created_at = now_text(), cancelled_at = NULL WHERE id = ?').run(status, accountId, previouslyCancelled.id);
  } else {
    await db.prepare('INSERT INTO event_registrations (event_id, member_id, registered_by_account_id, status) VALUES (?, ?, ?, ?)').run(eventId, memberId, accountId, status);
  }
  return status;
}

async function cancelRegistration(eventId, memberId) {
  await db
    .prepare("UPDATE event_registrations SET status = 'cancelled', cancelled_at = now_text() WHERE event_id = ? AND member_id = ? AND status != 'cancelled'")
    .run(eventId, memberId);
}

async function registrationsForEvent(eventId) {
  return db
    .prepare(
      `SELECT er.*, m.name AS "memberName" FROM event_registrations er
       JOIN members m ON m.id = er.member_id
       WHERE er.event_id = ? ORDER BY er.status = 'cancelled', er.created_at`
    )
    .all(eventId);
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

module.exports = {
  listEvents,
  getEvent,
  getEventWithDetails,
  createEvent,
  updateEvent,
  setEventStatus,
  setEventImage,
  deleteEvent,
  registerForEvent,
  cancelRegistration,
  registrationsForEvent,
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
