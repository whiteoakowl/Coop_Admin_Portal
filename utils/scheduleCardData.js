// DB-backed Schedule Card lookups - split out from scheduleCardBadge.js
// (which holds the plain constants) to avoid a require cycle with
// db/index.js, which needs the constants at startup to seed the default
// template. Mirrors utils/nameTagData.js.
const db = require('../db');
const { DEFAULT_LAYOUT } = require('./scheduleCardBadge');
const { getMemberSchedule } = require('./schedule');
const { familyOf } = require('./members');

// Converts a day's 4 { class_number, time, class_name, room, teacher }
// rows (the schedule module's shape) into the { time, className, room }
// shape the table element renderer expects.
function toTableRows(dayRows) {
  return dayRows.map((r) => ({ time: r.time, className: r.class_name, room: r.room }));
}

// The family's designated primary parent (see is_primary_parent on
// members - Members page), falling back to whichever parent in the
// family comes first alphabetically if nobody's been marked primary yet.
async function primaryParentFor(member) {
  const family = await familyOf(member.id);
  const parents = family.filter((m) => m.member_type === 'parent');
  if (parents.length === 0) return null;
  return parents.find((p) => p.is_primary_parent) || parents[0];
}

// Batch version of primaryParentFor for an arbitrary list of members - two
// queries total (every student's own family_id, then every parent in any
// of those families) instead of two PER student (familyOf's own shape),
// the same severe N+1 that made a real ~800-card bulk print time out (see
// scheduleCardDataForMembers below). Only ever populated for student
// members - a parent's own card never shows a phone line (see
// scheduleCardDataForMember's own comment). Returns
// { [memberId]: primaryParentRow | null }.
async function primaryParentsFor(members) {
  const studentIds = members.filter((m) => m.member_type === 'student').map((m) => m.id);
  if (studentIds.length === 0) return {};
  const placeholders = studentIds.map(() => '?').join(',');
  const selfRows = await db.prepare(`SELECT id, family_id FROM members WHERE id IN (${placeholders})`).all(...studentIds);
  const familyIds = [...new Set(selfRows.map((r) => r.family_id).filter((id) => id != null))];
  const parentsByFamily = {};
  if (familyIds.length > 0) {
    const familyPlaceholders = familyIds.map(() => '?').join(',');
    const parents = await db
      .prepare(`SELECT * FROM members WHERE family_id IN (${familyPlaceholders}) AND member_type = 'parent' AND active = 1 ORDER BY LOWER(name)`)
      .all(...familyIds);
    for (const p of parents) {
      if (!parentsByFamily[p.family_id]) parentsByFamily[p.family_id] = [];
      parentsByFamily[p.family_id].push(p);
    }
  }
  const result = {};
  for (const row of selfRows) {
    const parents = parentsByFamily[row.family_id] || [];
    result[row.id] = parents.find((p) => p.is_primary_parent) || parents[0] || null;
  }
  return result;
}

// The field values a Schedule Card template can place on a member's card.
// The parent-phone contact line is only meaningful on a student's card -
// a parent's own card leaves it blank rather than showing some other
// parent in the family (or, for a single-parent family, nothing at all
// since familyOf() excludes the card's own owner from the lookup).
// precomputedSchedule (optional) is a { monday, wednesday } already
// fetched by the caller (e.g. scheduleList's own already-batched rows) -
// skips this function's own getMemberSchedule call, which would
// otherwise redo a full live schedule computation per member when called
// in a loop over many members (see getMemberSchedule's own comment). Fine
// to call once per member for a single lookup; a caller iterating over
// many members at once (a bulk print) should use
// scheduleCardDataForMembers instead, which also batches the
// primaryParentFor lookup below.
async function scheduleCardDataForMember(member, precomputedSchedule) {
  const { monday, wednesday } = precomputedSchedule || (await getMemberSchedule(member.id));
  const primaryParent = member.member_type === 'student' ? await primaryParentFor(member) : null;
  return {
    name: member.name,
    allergy: member.medical_notes || '',
    primaryParentPhone: primaryParent ? `Parent Phone: ${primaryParent.phone || 'Not on file'}` : '',
    mondaySchedule: toTableRows(monday),
    wednesdaySchedule: toTableRows(wednesday),
  };
}

// Batch version of scheduleCardDataForMember for a bulk print flow
// (utils/cardPairs.js, routes/admin-schedule.js's print-cards route and
// its Student/Parent Schedules grid) - batches the primaryParentFor
// lookup above on top of the schedule batching those callers already do
// themselves (scheduleByMember, keyed by member id, from utils/
// schedule.js's schedulesForMembers/scheduleList). Returns
// { [memberId]: <same shape scheduleCardDataForMember returns> }.
async function scheduleCardDataForMembers(members, scheduleByMember) {
  const primaryParentByMember = await primaryParentsFor(members);
  const result = {};
  for (const member of members) {
    const schedule = scheduleByMember[member.id] || { monday: [], wednesday: [] };
    const primaryParent = primaryParentByMember[member.id] || null;
    result[member.id] = {
      name: member.name,
      allergy: member.medical_notes || '',
      primaryParentPhone: primaryParent ? `Parent Phone: ${primaryParent.phone || 'Not on file'}` : '',
      mondaySchedule: toTableRows(schedule.monday),
      wednesdaySchedule: toTableRows(schedule.wednesday),
    };
  }
  return result;
}

async function getScheduleCardTemplate() {
  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  if (!row) return DEFAULT_LAYOUT;
  try {
    return JSON.parse(row.layout_json);
  } catch (err) {
    return DEFAULT_LAYOUT;
  }
}

module.exports = { scheduleCardDataForMember, scheduleCardDataForMembers, getScheduleCardTemplate };
