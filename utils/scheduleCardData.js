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
function primaryParentFor(member) {
  const family = familyOf(member.id);
  const parents = family.filter((m) => m.member_type === 'parent');
  if (parents.length === 0) return null;
  return parents.find((p) => p.is_primary_parent) || parents[0];
}

// The field values a Schedule Card template can place on a member's card.
// The parent-phone contact line is only meaningful on a student's card -
// a parent's own card leaves it blank rather than showing some other
// parent in the family (or, for a single-parent family, nothing at all
// since familyOf() excludes the card's own owner from the lookup).
function scheduleCardDataForMember(member) {
  const { monday, wednesday } = getMemberSchedule(member.id);
  const primaryParent = member.member_type === 'student' ? primaryParentFor(member) : null;
  return {
    name: member.name,
    primaryParentPhone: primaryParent ? `Parent Phone: ${primaryParent.phone || 'Not on file'}` : '',
    mondaySchedule: toTableRows(monday),
    wednesdaySchedule: toTableRows(wednesday),
  };
}

function getScheduleCardTemplate() {
  const row = db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  if (!row) return DEFAULT_LAYOUT;
  try {
    return JSON.parse(row.layout_json);
  } catch (err) {
    return DEFAULT_LAYOUT;
  }
}

module.exports = { scheduleCardDataForMember, getScheduleCardTemplate };
