// Date helpers for the Monday/Wednesday session rosters.
// All dates are plain 'YYYY-MM-DD' strings evaluated in server local time,
// since this system is meant to run at a single physical kiosk location.

const DAY_INDEX = { monday: 1, wednesday: 3 };

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

// Returns 'monday' | 'wednesday' | null for a given ISO date.
function sessionDayForDate(iso) {
  const wd = weekdayOf(iso);
  if (wd === DAY_INDEX.monday) return 'monday';
  if (wd === DAY_INDEX.wednesday) return 'wednesday';
  return null;
}

// `count` occurrences of `dayName` ending on/before `latestIso`, ascending order.
function getOccurrences(dayName, count, latestIso) {
  const targetWd = DAY_INDEX[dayName];
  const d = parseISO(latestIso);
  while (d.getDay() !== targetWd) d.setDate(d.getDate() - 1);
  const dates = [];
  for (let i = 0; i < count; i++) {
    dates.push(toISOFromDate(d));
    d.setDate(d.getDate() - 7);
  }
  return dates.reverse();
}

// `count` occurrences of `dayName` on/after `fromIso`, ascending order.
function getUpcomingOccurrences(dayName, count, fromIso) {
  const targetWd = DAY_INDEX[dayName];
  const d = parseISO(fromIso);
  while (d.getDay() !== targetWd) d.setDate(d.getDate() + 1);
  const dates = [];
  for (let i = 0; i < count; i++) {
    dates.push(toISOFromDate(d));
    d.setDate(d.getDate() + 7);
  }
  return dates;
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

module.exports = {
  todayISO,
  addDays,
  weekdayOf,
  sessionDayForDate,
  getOccurrences,
  getUpcomingOccurrences,
  formatDateLabel,
  formatDateLong,
  formatTime,
};
