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
// Mainly meaningful for a student's card; a parent's own card just shows
// their family's primary contact same as anyone else's.
function primaryParentFor(member) {
  const family = familyOf(member.id);
  const parents = family.filter((m) => m.member_type === 'parent');
  if (parents.length === 0) return null;
  return parents.find((p) => p.is_primary_parent) || parents[0];
}

// The field values a Schedule Card template can place on a member's card.
function scheduleCardDataForMember(member) {
  const { monday, wednesday } = getMemberSchedule(member.id);
  const primaryParent = primaryParentFor(member);
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
