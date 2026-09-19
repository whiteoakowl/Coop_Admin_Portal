// Main Admin's Volunteers section (Committees, Sign-Up Lists, Volunteer
// Lists) - a real request: "main admin portal, volunteer tab, sub pages
// committees, sign up list, volunteer list." Named committeesAndSignup
// Lists.js, not volunteers.js - that name is already utils/volunteers.js,
// the pre-existing, unrelated Floater Assignments feature (day-based
// roster, not a per-slot signup list). See supabase/migrations/
// 20260918010000_committees_and_signup_lists.sql for the schema this
// implements, and that migration's own comment for why each of the three
// mirrors an existing Events shape (volunteer roles, donation items) as
// closely as possible instead of inventing new patterns.
const db = require('../db');
const { lastNameOf } = require('./members');

function sortByLastName(rows, field) {
  return rows.sort((a, b) => lastNameOf(a[field]).localeCompare(lastNameOf(b[field]), undefined, { sensitivity: 'base' }) || a[field].localeCompare(b[field], undefined, { sensitivity: 'base' }));
}

// --- Committees ---

// leader_name/leader_email are resolved from leader_member_id here (not
// stored redundantly on committees itself) so renaming/re-emailing a
// member in the Members list is instantly reflected wherever they're
// shown as a committee leader, same "never duplicate a member's own
// fields elsewhere" reasoning as committee_signups' own memberName/
// memberEmail join in positionsForCommittee below. Falls back to the old
// free-text leader_name/contact_info columns for a committee created
// before the leader-picker existed and never re-saved since.
const LEADER_JOIN = `LEFT JOIN members lm ON lm.id = c.leader_member_id`;
const LEADER_SELECT = `COALESCE(lm.name, c.leader_name) AS "leaderName", COALESCE(lm.email, c.contact_info) AS "leaderEmail"`;

async function listCommittees() {
  const committees = await db.prepare(`SELECT c.*, ${LEADER_SELECT} FROM committees c ${LEADER_JOIN} ORDER BY c.name`).all();
  for (const c of committees) {
    const counts = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM committee_signups cs
         JOIN committee_positions cp ON cp.id = cs.position_id
         WHERE cp.committee_id = ?`
      )
      .get(c.id);
    c.signupCount = Number(counts.c);
  }
  return committees;
}

async function getCommittee(id) {
  return db.prepare(`SELECT c.*, ${LEADER_SELECT} FROM committees c ${LEADER_JOIN} WHERE c.id = ?`).get(id);
}

async function createCommittee({ name, description, leaderMemberId }) {
  const info = await db
    .prepare('INSERT INTO committees (name, description, leader_member_id) VALUES (?, ?, ?)')
    .run(name, description || null, leaderMemberId || null);
  return info.lastInsertRowid;
}

async function updateCommittee(id, { name, description, leaderMemberId }) {
  await db
    .prepare('UPDATE committees SET name = ?, description = ?, leader_member_id = ? WHERE id = ?')
    .run(name, description || null, leaderMemberId || null, id);
}

async function setCommitteeEnabled(id, enabled) {
  await db.prepare('UPDATE committees SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

async function deleteCommittee(id) {
  await db.prepare('DELETE FROM committees WHERE id = ?').run(id);
}

async function positionsForCommittee(committeeId) {
  const positions = await db.prepare('SELECT * FROM committee_positions WHERE committee_id = ? ORDER BY position, id').all(committeeId);
  for (const p of positions) {
    p.signups = sortByLastName(
      await db
        .prepare(
          `SELECT cs.*, m.name AS "memberName", m.email AS "memberEmail" FROM committee_signups cs
           JOIN members m ON m.id = cs.member_id
           WHERE cs.position_id = ?`
        )
        .all(p.id),
      'memberName'
    );
  }
  return positions;
}

async function addCommitteePosition(committeeId, { positionName, slotsNeeded }) {
  await db
    .prepare('INSERT INTO committee_positions (committee_id, position_name, slots_needed) VALUES (?, ?, ?)')
    .run(committeeId, positionName, slotsNeeded || null);
}

async function updateCommitteePosition(id, { positionName, slotsNeeded }) {
  await db.prepare('UPDATE committee_positions SET position_name = ?, slots_needed = ? WHERE id = ?').run(positionName, slotsNeeded || null, id);
}

async function deleteCommitteePosition(id) {
  await db.prepare('DELETE FROM committee_positions WHERE id = ?').run(id);
}

// A plain roster of people on a committee - a real request: "add a member
// button," separate from committee_positions/committee_signups above
// (that pair is a NAMED role with a slot count that a member signs up for
// themselves, via their own portal account; this is just "this person is
// on this committee," added directly by Main Admin, no role or
// self-service involved).
async function membersForCommittee(committeeId) {
  return sortByLastName(
    await db
      .prepare(
        `SELECT cm.id, cm.member_id AS "memberId", m.name, m.email FROM committee_members cm
         JOIN members m ON m.id = cm.member_id
         WHERE cm.committee_id = ?`
      )
      .all(committeeId),
    'name'
  );
}

async function addCommitteeMember(committeeId, memberId) {
  await db
    .prepare('INSERT INTO committee_members (committee_id, member_id) VALUES (?, ?) ON CONFLICT (committee_id, member_id) DO NOTHING')
    .run(committeeId, memberId);
}

async function removeCommitteeMember(committeeId, memberId) {
  await db.prepare('DELETE FROM committee_members WHERE committee_id = ? AND member_id = ?').run(committeeId, memberId);
}

async function signUpForPosition(positionId, memberId, accountId) {
  await db
    .prepare('INSERT INTO committee_signups (position_id, member_id, signed_up_by_account_id) VALUES (?, ?, ?) ON CONFLICT (position_id, member_id) DO NOTHING')
    .run(positionId, memberId, accountId || null);
}

async function cancelCommitteeSignup(positionId, memberId) {
  await db.prepare('DELETE FROM committee_signups WHERE position_id = ? AND member_id = ?').run(positionId, memberId);
}

// --- Sign-Up Lists ("a list of things for people to sign up for") ---

async function listSignUpLists() {
  return db.prepare('SELECT sl.*, e.title AS "eventTitle" FROM sign_up_lists sl LEFT JOIN events e ON e.id = sl.event_id ORDER BY sl.created_at DESC').all();
}

async function getSignUpList(id) {
  return db.prepare('SELECT sl.*, e.title AS "eventTitle" FROM sign_up_lists sl LEFT JOIN events e ON e.id = sl.event_id WHERE sl.id = ?').get(id);
}

async function signUpListsForEvent(eventId) {
  return db.prepare('SELECT * FROM sign_up_lists WHERE event_id = ? ORDER BY created_at').all(eventId);
}

async function createSignUpList({ title, description, eventId }) {
  const info = await db.prepare('INSERT INTO sign_up_lists (title, description, event_id) VALUES (?, ?, ?)').run(title, description || null, eventId || null);
  return info.lastInsertRowid;
}

async function updateSignUpList(id, { title, description, eventId }) {
  await db.prepare('UPDATE sign_up_lists SET title = ?, description = ?, event_id = ? WHERE id = ?').run(title, description || null, eventId || null, id);
}

async function deleteSignUpList(id) {
  await db.prepare('DELETE FROM sign_up_lists WHERE id = ?').run(id);
}

async function itemsForSignUpList(listId) {
  const items = await db.prepare('SELECT * FROM sign_up_list_items WHERE list_id = ? ORDER BY position, id').all(listId);
  for (const item of items) {
    item.claims = sortByLastName(
      await db
        .prepare(
          `SELECT c.*, m.name AS "memberName" FROM sign_up_list_claims c
           JOIN members m ON m.id = c.member_id
           WHERE c.item_id = ?`
        )
        .all(item.id),
      'memberName'
    );
    item.quantityClaimed = item.claims.reduce((sum, c) => sum + c.quantity_claimed, 0);
  }
  return items;
}

async function addSignUpItem(listId, { itemName, quantityNeeded, notes }) {
  await db
    .prepare('INSERT INTO sign_up_list_items (list_id, item_name, quantity_needed, notes) VALUES (?, ?, ?, ?)')
    .run(listId, itemName, quantityNeeded || 1, notes || null);
}

async function updateSignUpItem(id, { itemName, quantityNeeded, notes }) {
  await db.prepare('UPDATE sign_up_list_items SET item_name = ?, quantity_needed = ?, notes = ? WHERE id = ?').run(itemName, quantityNeeded || 1, notes || null, id);
}

async function deleteSignUpItem(id) {
  await db.prepare('DELETE FROM sign_up_list_items WHERE id = ?').run(id);
}

// Clamps to what's actually still needed - same shape as utils/events.js's
// own claimDonationItem/claimFoodItem, for the same reason: two members
// racing to claim the last couple of an item shouldn't be able to combine
// for more than quantity_needed actually calls for.
async function claimSignUpItem(itemId, memberId, quantity, accountId) {
  const item = await db.prepare('SELECT * FROM sign_up_list_items WHERE id = ?').get(itemId);
  if (!item) return 0;
  const claimedSoFar = Number((await db.prepare('SELECT COALESCE(SUM(quantity_claimed), 0) AS q FROM sign_up_list_claims WHERE item_id = ?').get(itemId)).q);
  const remaining = Math.max(0, item.quantity_needed - claimedSoFar);
  const toClaim = Math.min(remaining, Math.max(1, Number(quantity) || 1));
  if (toClaim <= 0) return 0;
  await db
    .prepare('INSERT INTO sign_up_list_claims (item_id, member_id, quantity_claimed, claimed_by_account_id) VALUES (?, ?, ?, ?)')
    .run(itemId, memberId, toClaim, accountId || null);
  return toClaim;
}

async function cancelSignUpClaim(claimId) {
  await db.prepare('DELETE FROM sign_up_list_claims WHERE id = ?').run(claimId);
}

// --- Volunteer Lists ("a list of jobs by date or hour that members can
// sign up for") ---

async function listVolunteerLists() {
  return db.prepare('SELECT vl.*, e.title AS "eventTitle" FROM volunteer_signup_lists vl LEFT JOIN events e ON e.id = vl.event_id ORDER BY vl.created_at DESC').all();
}

async function getVolunteerList(id) {
  return db.prepare('SELECT vl.*, e.title AS "eventTitle" FROM volunteer_signup_lists vl LEFT JOIN events e ON e.id = vl.event_id WHERE vl.id = ?').get(id);
}

async function volunteerListsForEvent(eventId) {
  return db.prepare('SELECT * FROM volunteer_signup_lists WHERE event_id = ? ORDER BY created_at').all(eventId);
}

async function createVolunteerList({ title, description, eventId }) {
  const info = await db.prepare('INSERT INTO volunteer_signup_lists (title, description, event_id) VALUES (?, ?, ?)').run(title, description || null, eventId || null);
  return info.lastInsertRowid;
}

async function updateVolunteerList(id, { title, description, eventId }) {
  await db.prepare('UPDATE volunteer_signup_lists SET title = ?, description = ?, event_id = ? WHERE id = ?').run(title, description || null, eventId || null, id);
}

async function deleteVolunteerList(id) {
  await db.prepare('DELETE FROM volunteer_signup_lists WHERE id = ?').run(id);
}

async function shiftsForVolunteerList(listId) {
  const shifts = await db.prepare('SELECT * FROM volunteer_signup_list_shifts WHERE list_id = ? ORDER BY position, shift_date, start_time, id').all(listId);
  for (const shift of shifts) {
    shift.signups = sortByLastName(
      await db
        .prepare(
          `SELECT vs.*, m.name AS "memberName" FROM volunteer_signup_list_signups vs
           JOIN members m ON m.id = vs.member_id
           WHERE vs.shift_id = ?`
        )
        .all(shift.id),
      'memberName'
    );
  }
  return shifts;
}

async function addVolunteerShift(listId, { jobName, shiftDate, startTime, endTime, slotsNeeded }) {
  await db
    .prepare('INSERT INTO volunteer_signup_list_shifts (list_id, job_name, shift_date, start_time, end_time, slots_needed) VALUES (?, ?, ?, ?, ?, ?)')
    .run(listId, jobName, shiftDate || null, startTime || null, endTime || null, slotsNeeded || 1);
}

async function updateVolunteerShift(id, { jobName, shiftDate, startTime, endTime, slotsNeeded }) {
  await db
    .prepare('UPDATE volunteer_signup_list_shifts SET job_name = ?, shift_date = ?, start_time = ?, end_time = ?, slots_needed = ? WHERE id = ?')
    .run(jobName, shiftDate || null, startTime || null, endTime || null, slotsNeeded || 1, id);
}

async function deleteVolunteerShift(id) {
  await db.prepare('DELETE FROM volunteer_signup_list_shifts WHERE id = ?').run(id);
}

async function signUpForShift(shiftId, memberId, accountId) {
  await db
    .prepare('INSERT INTO volunteer_signup_list_signups (shift_id, member_id, signed_up_by_account_id) VALUES (?, ?, ?) ON CONFLICT (shift_id, member_id) DO NOTHING')
    .run(shiftId, memberId, accountId || null);
}

async function cancelShiftSignup(shiftId, memberId) {
  await db.prepare('DELETE FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').run(shiftId, memberId);
}

module.exports = {
  listCommittees,
  getCommittee,
  createCommittee,
  updateCommittee,
  setCommitteeEnabled,
  deleteCommittee,
  positionsForCommittee,
  addCommitteePosition,
  updateCommitteePosition,
  deleteCommitteePosition,
  signUpForPosition,
  cancelCommitteeSignup,
  membersForCommittee,
  addCommitteeMember,
  removeCommitteeMember,
  listSignUpLists,
  getSignUpList,
  signUpListsForEvent,
  createSignUpList,
  updateSignUpList,
  deleteSignUpList,
  itemsForSignUpList,
  addSignUpItem,
  updateSignUpItem,
  deleteSignUpItem,
  claimSignUpItem,
  cancelSignUpClaim,
  listVolunteerLists,
  getVolunteerList,
  volunteerListsForEvent,
  createVolunteerList,
  updateVolunteerList,
  deleteVolunteerList,
  shiftsForVolunteerList,
  addVolunteerShift,
  updateVolunteerShift,
  deleteVolunteerShift,
  signUpForShift,
  cancelShiftSignup,
};
