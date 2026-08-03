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

module.exports = {
  todayISO,
  addDays,
  weekdayOf,
  isValidISODate,
  formatDateLabel,
  formatDateLong,
  formatTime,
};
