// Shared by both the Volunteers and Setup/Cleanup features, which each
// have exactly two fixed lists: one for Monday, one for Wednesday.
const { todayISO, weekdayOf } = require('./dates');

const DAYS = ['monday', 'wednesday'];
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday' };
const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

function isValidDay(day) {
  return DAYS.includes(day);
}

// "Mon"/"Monday"/"Wed"/"Wednesday", case-insensitive, trimmed - real
// spreadsheet imports (a class schedule, a member's weekly schedule) are
// at least as likely to use the 3-letter abbreviation as the full word.
// Anything else (including a day this app has no model for, e.g.
// "Thursday") resolves to null rather than guessing.
function parseDayValue(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('mon')) return 'monday';
  if (v.startsWith('wed')) return 'wednesday';
  return null;
}

// Express middleware shared by every :day route (Volunteers, Setup/Cleanup)
// to 404 on anything other than 'monday'/'wednesday'.
function requireDay(req, res, next) {
  if (!isValidDay(req.params.day)) return res.status(404).send('Not found');
  next();
}

// The co-op only meets Monday and Wednesday, so homepage links that don't
// ask which day (Floater Assignments, Setup/Cleanup) auto-pick whichever
// of the two is soonest: today if it's a meeting day, otherwise the next
// upcoming one.
function defaultDay() {
  const dow = new Date().getDay(); // 0=Sun..6=Sat
  if (dow === 1) return 'monday';
  if (dow === 2 || dow === 3) return 'wednesday';
  return 'monday';
}

// Only meaningful when today itself falls on the given day - otherwise
// there's no real "today" to default to for a Monday/Wednesday-scoped view
// (e.g. looking at Monday's Setup/Cleanup teams on a Wednesday). Shared by
// every day-scoped page that highlights "as of today" state against a
// specific date: the Class Schedule grid's absent-student flag and Setup/
// Cleanup Teams' absent-member highlight both key off this.
function defaultDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : '';
}

module.exports = { DAYS, DAY_LABELS, isValidDay, parseDayValue, defaultDay, requireDay, defaultDateFor };
