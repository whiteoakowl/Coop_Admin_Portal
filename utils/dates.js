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

function formatTime(epochMs) {
  if (!epochMs) return null;
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

module.exports = {
  todayISO,
  addDays,
  weekdayOf,
  isValidISODate,
  formatDateLabel,
  formatDateLong,
  formatTime,
  formatTimeOfDay,
  formatTimestamp,
  ageFromBirthday,
};
