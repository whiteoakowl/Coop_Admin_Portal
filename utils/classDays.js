// Pure day-of-week constants/validators for the Classes grid's "Day
// Settings" (class_schedules) feature - a standalone leaf module (no
// dependency on utils/classSchedule.js or utils/volunteers.js, same
// reasoning as utils/appSettings.js) so modules on both sides of that
// relationship (utils/volunteers.js, which utils/classSchedule.js itself
// depends on) can both validate a day without a circular require.
// Independent of utils/days.js's own DAYS (still just Monday/Wednesday,
// shared by Volunteers/Setup-Cleanup's older, narrower route gating in
// whatever call sites haven't adopted these yet).
const CLASS_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const CLASS_DAY_ORDER = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const CLASS_DAY_LABELS_FULL = {
  sunday: 'Sunday',
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
};
// JS Date#getDay() convention (0=Sun..6=Sat) - the full-week equivalent of
// utils/days.js's own 2-value DAY_WEEKDAY, for call sites (e.g. Floater
// Assignments' Class Cancellation Risk tab) that need to compare "today"
// against any day of the week, not just Monday/Wednesday.
const CLASS_DAY_WEEKDAY_FULL = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// "Mon"/"Monday"/"Tue"/"Tuesday"/etc., case-insensitive, trimmed - the
// full-week equivalent of utils/days.js's own parseDayValue, for
// spreadsheet imports (Task List CSV import) that may now encounter any
// day of the week, not just Mon/Wed.
const CLASS_DAY_ABBREVIATIONS = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
function parseClassDayValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return CLASS_DAY_ABBREVIATIONS[v.slice(0, 3)] || null;
}

// A Classes-specific isValidDay/requireDay, independent of utils/days.js's
// own (still Monday/Wednesday-only in whatever call sites haven't adopted
// this yet). routes/admin-class-schedule.js's, routes/admin-volunteers.js's,
// and routes/admin-setup.js's own :day-gated routes use these instead, so
// a newly-activated day (e.g. Tuesday) works everywhere immediately
// rather than 404ing on the older, narrower shared middleware.
function isValidClassDay(day) {
  return CLASS_DAYS.includes(day);
}

function requireClassDay(req, res, next) {
  if (!isValidClassDay(req.params.day)) return res.status(404).send('Not found');
  next();
}

module.exports = {
  CLASS_DAYS,
  CLASS_DAY_ORDER,
  CLASS_DAY_LABELS_FULL,
  CLASS_DAY_WEEKDAY_FULL,
  parseClassDayValue,
  isValidClassDay,
  requireClassDay,
};
