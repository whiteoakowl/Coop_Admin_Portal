// Annual Calendar (Main Admin) - a real request: "Main admin portal, add
// a tab called annual calendar. This calendar will work similar to the
// family school management attendance calendar where you can click on
// the dates to change the color... Dropdown menu for each fiscal year
// created in the system. Can create a calendar for each fiscal year.
// Create key button. Be able to add a label and color for each key
// item. Key shows on page. Be able to click each key then click on the
// calendar dates to color/key each one that particular key." One
// calendar per fiscal year (utils/events.js's own listFiscalYears/
// fiscal_years table), each calendar owns its own set of keys (a
// label+color pair, same shape as event_categories) and its own colored
// dates - a date holds at most one key at a time (clicking the already-
// applied key again clears it, same "click to toggle" shape utils/
// familySchool.js's own toggleAttendance already established, just
// generalized from 2 fixed colors to however many keys the admin makes).
const db = require('../db');
const { formatDateShort } = require('./dates');
const { monthGridDays } = require('./familySchool');

async function listFiscalYears() {
  return db.prepare('SELECT * FROM fiscal_years ORDER BY start_date DESC').all();
}

function fiscalYearLabel(fy) {
  return `${formatDateShort(fy.start_date)} - ${formatDateShort(fy.end_date)}`;
}

// A real request: "Titl of page should be the school year such as
// 2026-2027." fiscalYearLabel above (the exact date range) stays as
// the dropdown's own option text; the print/PDF page title uses this
// shorter "YYYY-YYYY" form instead, derived straight from the fiscal
// year's own start/end years (fiscal years aren't necessarily Jan-Dec
// or Aug-Jul, so this reads directly off whatever years the admin
// actually entered rather than assuming a fixed school-year boundary).
function fiscalYearSchoolYearLabel(fy) {
  const startYear = fy.start_date.slice(0, 4);
  const endYear = fy.end_date.slice(0, 4);
  return startYear === endYear ? startYear : `${startYear}-${endYear}`;
}

async function getFiscalYear(id) {
  return db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(id);
}

async function calendarForFiscalYear(fiscalYearId) {
  return db.prepare('SELECT * FROM annual_calendars WHERE fiscal_year_id = ?').get(fiscalYearId);
}

async function createCalendar(fiscalYearId) {
  const existing = await calendarForFiscalYear(fiscalYearId);
  if (existing) return existing;
  return db.prepare('INSERT INTO annual_calendars (fiscal_year_id) VALUES (?) RETURNING *').get(fiscalYearId);
}

async function getCalendar(id) {
  return db.prepare('SELECT * FROM annual_calendars WHERE id = ?').get(id);
}

// A real request: "Add edit calendar colors buttons. This button will
// allow you to set the color for the month row and set the color for
// the days of the week row." These are this site's own existing
// defaults (public/css/styles.css's own .annual-calendar-month h3/
// .fs-attendance-calendar th rules) - a calendar with nothing picked
// yet (month_row_color/weekday_row_color both null) renders identically
// to before this feature existed.
const DEFAULT_MONTH_ROW_COLOR = '#2e6da4';
const DEFAULT_WEEKDAY_ROW_COLOR = '#e2e8f0';

async function updateCalendarColors(calendarId, monthRowColor, weekdayRowColor) {
  await db
    .prepare('UPDATE annual_calendars SET month_row_color = ?, weekday_row_color = ? WHERE id = ?')
    .run(monthRowColor || null, weekdayRowColor || null, calendarId);
}

// --- Keys (a label+color pair, same shape as event_categories). ---

async function keysForCalendar(calendarId) {
  return db.prepare('SELECT * FROM annual_calendar_keys WHERE calendar_id = ? ORDER BY position, id').all(calendarId);
}

async function createKey(calendarId, label, color) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM annual_calendar_keys WHERE calendar_id = ?').get(calendarId)).p) + 1;
  return db
    .prepare('INSERT INTO annual_calendar_keys (calendar_id, label, color, position) VALUES (?, ?, ?, ?) RETURNING *')
    .get(calendarId, label, color || '#EE9A4D', position);
}

async function getKey(id) {
  return db.prepare('SELECT * FROM annual_calendar_keys WHERE id = ?').get(id);
}

async function updateKey(id, label, color) {
  await db.prepare('UPDATE annual_calendar_keys SET label = ?, color = ? WHERE id = ?').run(label, color || '#EE9A4D', id);
}

async function deleteKey(id) {
  // annual_calendar_days.key_id references this on delete set null, so
  // any date already colored with this key just clears back to unmarked
  // instead of orphaning a dangling key_id.
  await db.prepare('DELETE FROM annual_calendar_keys WHERE id = ?').run(id);
}

// --- Days (one row per colored date - absent entirely means unmarked). ---

async function keyByDateForCalendar(calendarId) {
  const rows = await db
    .prepare(
      `SELECT d.day_date, d.key_id, k.label, k.color
       FROM annual_calendar_days d JOIN annual_calendar_keys k ON k.id = d.key_id
       WHERE d.calendar_id = ?`
    )
    .all(calendarId);
  const byDate = {};
  for (const r of rows) byDate[r.day_date] = { keyId: r.key_id, label: r.label, color: r.color };
  return byDate;
}

// Clicking a key then a date applies that key; clicking the same key on
// an already-keyed date clears it back to unmarked - the same click-to-
// toggle shape the Family Attendance calendar already uses, generalized
// from a fixed 2-color cycle to whichever key is currently selected.
async function toggleDay(calendarId, date, keyId) {
  const existing = await db.prepare('SELECT key_id FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendarId, date);
  if (existing && Number(existing.key_id) === Number(keyId)) {
    await db.prepare('DELETE FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').run(calendarId, date);
    return null;
  }
  if (existing) {
    await db.prepare('UPDATE annual_calendar_days SET key_id = ?, updated_at = now_text() WHERE calendar_id = ? AND day_date = ?').run(keyId, calendarId, date);
  } else {
    await db.prepare('INSERT INTO annual_calendar_days (calendar_id, day_date, key_id) VALUES (?, ?, ?)').run(calendarId, date, keyId);
  }
  return getKey(keyId);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Mobile and desktop view should show the full 12 month calendar" - 12
// consecutive calendar months starting at the fiscal year's own start
// month (fiscal years are admin-entered date ranges, utils/events.js,
// not necessarily Jan-Dec), same shape as utils/familySchool.js's own
// attendanceForSchoolYear (12 fixed Aug-Jul months) but generalized to
// start wherever this particular fiscal year starts.
function monthsForFiscalYear(fiscalYear, keyByDate) {
  const startYear = parseInt(fiscalYear.start_date.slice(0, 4), 10);
  const startMonth = parseInt(fiscalYear.start_date.slice(5, 7), 10);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const month = ((startMonth - 1 + i) % 12) + 1;
    const year = startYear + Math.floor((startMonth - 1 + i) / 12);
    months.push({ year, month, weeks: monthGridDays(year, month), keyByDate: keyByDate || {} });
  }
  return months;
}

module.exports = {
  listFiscalYears,
  fiscalYearLabel,
  fiscalYearSchoolYearLabel,
  getFiscalYear,
  calendarForFiscalYear,
  createCalendar,
  getCalendar,
  updateCalendarColors,
  DEFAULT_MONTH_ROW_COLOR,
  DEFAULT_WEEKDAY_ROW_COLOR,
  keysForCalendar,
  createKey,
  getKey,
  updateKey,
  deleteKey,
  keyByDateForCalendar,
  toggleDay,
  monthsForFiscalYear,
  MONTH_NAMES,
};
