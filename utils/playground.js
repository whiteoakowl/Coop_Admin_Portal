// Playground Check-In: an open drop-in log, not a fixed roster - "anybody
// can check in and out of the playground. it doesn't have a set roster."
// Reuses the same rosters/attendance/checkouts tables every other roster
// on this site uses (one roster per (day, hour_position), lazily created
// the same way a class's own roster is - see ensureClassRoster in
// utils/classSchedule.js), so every existing table/index/constraint
// already covers it. The one real difference: "who's on it" is never a
// fixed roster_members list - it's simply whoever has an attendance/
// checkouts row for that roster+date, since anybody can walk up and check
// in with no enrollment step at all (see playgroundLogForDate below).
const db = require('../db');
const { DAY_LABELS, hoursForDay } = require('./classSchedule');
const { byLastName } = require('./members');
const { formatTime } = require('./dates');

// The same per-day hour label (e.g. "Hour 1", or whatever an admin has
// renamed it to on the Class Schedule page's Edit Hours dialog) every
// class under that slot already shows - playground runs alongside classes
// during the same hour blocks, so it reuses their labels rather than
// keeping a second, independent set.
async function playgroundHourLabel(day, hourPosition) {
  const hours = await hoursForDay(day);
  const hour = hours.find((h) => h.position === hourPosition);
  return hour ? hour.label : `Hour ${hourPosition}`;
}

// Creates (once) the roster backing one (day, hour) playground slot, or
// returns the existing one - same lazy-create-on-first-use shape as
// ensureClassRoster/ensureDayRoster in utils/classSchedule.js.
async function ensurePlaygroundRoster(day, hourPosition) {
  const existing = await db.prepare('SELECT roster_id FROM playground_rosters WHERE day = ? AND hour_position = ?').get(day, hourPosition);
  if (existing) {
    const roster = await db.prepare('SELECT id FROM rosters WHERE id = ?').get(existing.roster_id);
    if (roster) return existing.roster_id;
  }
  const label = await playgroundHourLabel(day, hourPosition);
  const info = await db
    .prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)')
    .run(`Playground - ${DAY_LABELS[day]} ${label}`, 'Playground', day);
  const rosterId = info.lastInsertRowid;
  await db
    .prepare(
      `INSERT INTO playground_rosters (day, hour_position, roster_id) VALUES (?, ?, ?)
       ON CONFLICT (day, hour_position) DO UPDATE SET roster_id = excluded.roster_id`
    )
    .run(day, hourPosition, rosterId);
  return rosterId;
}

// The open drop-in log for one playground roster on one date: whoever has
// an attendance and/or checkouts row for it, regardless of whether they
// were ever "enrolled" anywhere (there's nothing to enroll in) - unlike
// rosterMembers (utils/rosterGrid.js), which starts from roster_members
// and would show nobody at all here, since a playground roster never gets
// roster_members rows in the first place.
async function playgroundLogForDate(rosterId, date) {
  if (!date) return [];
  const rows = await db
    .prepare(
      `SELECT m.name AS name, a.check_in_time AS "checkInTime", c.check_out_time AS "checkOutTime"
       FROM members m
       LEFT JOIN attendance a ON a.member_id = m.id AND a.roster_id = ? AND a.session_date = ?
       LEFT JOIN checkouts c ON c.member_id = m.id AND c.roster_id = ? AND c.session_date = ?
       WHERE a.id IS NOT NULL OR c.id IS NOT NULL`
    )
    .all(rosterId, date, rosterId, date);
  return rows
    .sort(byLastName)
    .map((r) => ({
      name: r.name,
      checkInTime: r.checkInTime ? formatTime(r.checkInTime) : null,
      checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : null,
    }));
}

module.exports = { ensurePlaygroundRoster, playgroundHourLabel, playgroundLogForDate };
