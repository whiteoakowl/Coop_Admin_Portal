// Generic date helpers. All dates are plain 'YYYY-MM-DD' strings, standing
// for a calendar day at the co-op's own physical location (Eastern time),
// not wherever the server process happens to be running.

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

// A real bug: this used to build today's date from new Date()'s LOCAL
// Y/M/D, same underlying mistake formatTime() below was already fixed
// for ("check in and out times should read Eastern Time") - Netlify
// Functions run in UTC, so from ~8pm-midnight Eastern the UTC clock has
// already rolled to the next calendar day, and every "today" comparison
// across the app (dashboard stats, alerts, attendance filtering, session
// dates) silently pointed at tomorrow instead. Intl's en-CA locale
// formats as YYYY-MM-DD directly, so no separate re-assembly is needed.
const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayISO() {
  return EASTERN_DATE_FORMATTER.format(new Date());
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
// A real bug report: "check in and out times should read Eastern Time
// (ET)." With no explicit timeZone, toLocaleTimeString renders in
// whatever OS timezone the Node process itself is running in - fine
// locally, but Netlify Functions run in UTC, so every check-in/check-out
// time showed hours ahead of the co-op's actual (Eastern) time once
// deployed. 'America/New_York' is a real IANA zone, so this already
// accounts for EST/EDT automatically rather than needing a fixed offset.
function formatTime(epochMs) {
  const ms = Number(epochMs);
  if (!ms) return null;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

// Formats a plain "HH:MM" (24-hour, from an <input type="time">) as a
// friendly 12-hour label, e.g. "08:30" -> "8:30 AM".
function formatTimeOfDay(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Formats a `now_text()` timestamp string (UTC, "YYYY-MM-DD HH:MM:SS") as a
// timestamp label in the co-op's own Eastern time - same reasoning as
// formatTime above (Netlify Functions run in UTC), which this used to be
// missing.
function formatTimestamp(sqlTimestamp) {
  if (!sqlTimestamp) return null;
  const d = new Date(sqlTimestamp.replace(' ', 'T') + 'Z');
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Formats a `now_text()` timestamp string (UTC, "YYYY-MM-DD HH:MM:SS") as
// "December 1, 2025 9:52am" in Eastern time - used for the library's scan
// timestamps. Reads the components back out through an Eastern-zoned
// formatter (rather than the Date object's own UTC-local getHours/
// getDate/etc.) for the same reason formatTimestamp above needs to.
function formatFriendlyTimestamp(sqlTimestamp) {
  if (!sqlTimestamp) return null;
  const d = new Date(sqlTimestamp.replace(' ', 'T') + 'Z');
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  const monthName = MONTHS_LONG[Number(parts.month) - 1];
  const ampm = parts.dayPeriod.toLowerCase();
  return `${monthName} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute}${ampm}`;
}

// Whole-years-old as of today, or null if the birthday isn't a valid date.
function ageFromBirthday(iso) {
  if (!isValidISODate(iso)) return null;
  const birth = parseISO(iso);
  const today = parseISO(todayISO());
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
