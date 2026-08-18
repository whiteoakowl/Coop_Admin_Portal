// Generic date helpers. All dates are plain 'YYYY-MM-DD' strings evaluated
// in server local time, since this system is meant to run at a single
// physical kiosk location.

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISOFromDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayISO() {
  return toISOFromDate(new Date());
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISOFromDate(d);
}

function weekdayOf(iso) {
  return parseISO(iso).getDay();
}

function isValidISODate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = parseISO(iso);
  return !Number.isNaN(d.getTime()) && toISOFromDate(d) === iso;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDateLabel(iso) {
  const d = parseISO(iso);
  return `${WEEKDAY_SHORT[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateLong(iso) {
  const d = parseISO(iso);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${WEEKDAY_SHORT[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// A real request: a student's imported birthday showed on the Members
// list as its own raw stored ISO value ("2026-02-03") - reads as a sort
// key, not a birthday. MM/DD/YYYY, zero-padded, matches how every other
// date-entry field in this app already displays to an admin (the
// membership form's own <input type="date"> renders this way natively).
function formatDateNumeric(iso) {
  const d = parseISO(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

// epochMs comes straight from a Postgres bigint column (attendance.
// check_in_time, checkouts.check_out_time) - the pg driver returns a
// bigint as a STRING, not a number, to avoid silent precision loss on
// values bigger than Number.MAX_SAFE_INTEGER (irrelevant for an epoch-ms
// timestamp, which never gets that large). new Date() treats a numeric
// STRING as an unparseable date string, not as milliseconds-since-epoch,
// so passing the raw string straight through silently produced
// "Invalid Date" on any real (Postgres-backed) deploy - invisible in
// local dev/tests, which run on PGlite, whose driver already returns a
// bigint as a plain number. Number(epochMs) is a no-op when it's already
// a number (PGlite, or any caller passing one directly, per this
// function's own tests), so this is safe for both backends.
function formatTime(epochMs) {
  const ms = Number(epochMs);
  if (!ms) return null;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Formats a plain "HH:MM" (24-hour, from an <input type="time">) as a
// friendly 12-hour label, e.g. "08:30" -> "8:30 AM".
function formatTimeOfDay(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Formats a SQLite `datetime('now')` string (UTC, "YYYY-MM-DD HH:MM:SS")
// as a local timestamp label.
function formatTimestamp(sqlTimestamp) {
  if (!sqlTimestamp) return null;
  const d = new Date(sqlTimestamp.replace(' ', 'T') + 'Z');
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Formats a SQLite `datetime('now')` string (UTC, "YYYY-MM-DD HH:MM:SS") as
// "December 1, 2025 9:52am" - used for the library's scan timestamps.
function formatFriendlyTimestamp(sqlTimestamp) {
  if (!sqlTimestamp) return null;
  const d = new Date(sqlTimestamp.replace(' ', 'T') + 'Z');
  let hours = d.getHours();
  const minutes = pad(d.getMinutes());
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hours}:${minutes}${ampm}`;
}

// Whole-years-old as of today, or null if the birthday isn't a valid date.
function ageFromBirthday(iso) {
  if (!isValidISODate(iso)) return null;
  const birth = parseISO(iso);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hadBirthdayThisYear = today.getMonth() > birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hadBirthdayThisYear) age--;
  return age >= 0 ? age : null;
}

// Picks "today, or the closest date coming up" out of an unsorted list of
// ISO dates - a real request for the public kiosk Floater Assignments/
// Setup-Cleanup pages, which used to only ever show something on the
// exact day a session date landed on and went blank every other day.
// Never looks backward (a past date is stale, not "closest") - returns
// null when nothing in `dates` is today or later, so the caller can fall
// back to its own "nothing scheduled" message. `today` is injectable for
// tests; defaults to the real today.
function closestUpcomingDate(dates, today) {
  const ref = today || todayISO();
  const upcoming = dates.filter((d) => d >= ref).sort();
  return upcoming[0] || null;
}

module.exports = {
  todayISO,
  addDays,
  weekdayOf,
  isValidISODate,
  formatDateLabel,
  formatDateLong,
  formatDateNumeric,
  formatTime,
  formatTimeOfDay,
  formatTimestamp,
  formatFriendlyTimestamp,
  ageFromBirthday,
  closestUpcomingDate,
};
