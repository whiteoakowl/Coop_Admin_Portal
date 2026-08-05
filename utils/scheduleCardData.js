// DB-backed Schedule Card lookups - split out from scheduleCardBadge.js
// (which holds the plain constants) to avoid a require cycle with
// db/index.js, which needs the constants at startup to seed the default
// template. Mirrors utils/nameTagData.js.
const db = require('../db');
const { DEFAULT_LAYOUT } = require('./scheduleCardBadge');
const { getMemberSchedule } = require('./schedule');

// Converts a day's 4 { class_number, time, class_name, room, teacher }
// rows (the schedule module's shape) into the { time, className, room }
// shape the table element renderer expects.
function toTableRows(dayRows) {
  return dayRows.map((r) => ({ time: r.time, className: r.class_name, room: r.room }));
}

// The field values a Schedule Card template can place on a member's card.
function scheduleCardDataForMember(member) {
  const { monday, wednesday } = getMemberSchedule(member.id);
  return {
    name: member.name,
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
