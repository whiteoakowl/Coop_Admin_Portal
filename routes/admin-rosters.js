const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatTime, todayISO, weekdayOf } = require('../utils/dates');
const { familyOf } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { arrivalDepartureLabels } = require('../utils/schedule');
const { ensureDayRoster, classesAtRiskForDay, classesNeedingStaffForDay } = require('../utils/classSchedule');
const { defaultDay, DAY_LABELS } = require('../utils/days');
const { REASON_LABELS } = require('../utils/rosters');

// The alert log below the grid only makes sense for today, and only when
// today is actually a session day for this roster's day-of-week (mirrors
// the Floater Assignments Substitutes board's same-shaped default).
const DAY_WEEKDAY = { monday: 1, wednesday: 3 };
function todayIfSessionDay(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : null;
}

// Absence/Late form submissions on this roster for one date, split by
// status - feeds the Attendance page's "Today's Alerts" log.
function absenceFormSubmissionsForRoster(rosterId, date) {
  if (!date) return { absences: [], lates: [] };
  const rows = db
    .prepare(
      `SELECT m.name AS memberName, a.status, a.reason_category AS reasonCategory, a.reason_text AS reasonText
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.roster_id = ? AND a.session_date = ? AND a.source = 'absence_form'
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(rosterId, date)
    .map((r) => ({
      memberName: r.memberName,
      status: r.status,
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
  return {
    absences: rows.filter((r) => r.status === 'absent'),
    lates: rows.filter((r) => r.status === 'late'),
  };
}

// Attendance is now exactly these 4 always-existing, schedule-driven
// rosters - membership fills in automatically from class enrollment/
// staffing (see utils/classSchedule.js), so there's no roster creation,
// archiving, or category system left to manage here.
const TABS = {
  'monday-parent': { day: 'monday', role: 'parent', label: 'Monday Parents' },
  'monday-student': { day: 'monday', role: 'student', label: 'Monday Students' },
  'wednesday-parent': { day: 'wednesday', role: 'parent', label: 'Wednesday Parents' },
  'wednesday-student': { day: 'wednesday', role: 'student', label: 'Wednesday Students' },
};

function rosterIdForTab(tab) {
  const cfg = TABS[tab];
  return cfg ? ensureDayRoster(cfg.day, cfg.role) : null;
}

function rosterMembers(rosterId) {
  return db
    .prepare(
      `SELECT m.*
       FROM members m
       JOIN roster_members rm ON rm.member_id = m.id
       WHERE rm.roster_id = ? AND m.active = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(rosterId);
}

function rosterDates(rosterId) {
  return db
    .prepare('SELECT session_date FROM roster_dates WHERE roster_id = ? ORDER BY session_date ASC')
    .all(rosterId)
    .map((r) => r.session_date);
}

function buildRosterGridData(roster) {
  const dates = rosterDates(roster.id);
  const placeholders = dates.map(() => '?').join(',');
  const members = rosterMembers(roster.id);

  const attendanceRows = members.length && dates.length
    ? db
        .prepare(
          `SELECT member_id, session_date, status, check_in_time FROM attendance
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];
  const checkoutRows = members.length && dates.length
    ? db
        .prepare(
          `SELECT member_id, session_date, number, check_out_time FROM checkouts
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];

  const attendanceByKey = {};
  for (const r of attendanceRows) attendanceByKey[`${r.member_id}|${r.session_date}`] = r;
  const checkoutByKey = {};
  for (const r of checkoutRows) checkoutByKey[`${r.member_id}|${r.session_date}`] = r;

  const rows = members.map((m) => {
    const { arrival, departure } = arrivalDepartureLabels(m.id, roster.schedule_day);
    return {
      member: m,
      parentName: familyOf(m.id).map((p) => p.name).join(', ') || null,
      arrivalLabel: arrival,
      departureLabel: departure,
      cells: dates.map((d) => {
        const att = attendanceByKey[`${m.id}|${d}`];
        const out = checkoutByKey[`${m.id}|${d}`];
        if (!att) return { date: d, tag: null, checkInTime: null, checkOutTime: null, number: null };
        const tag = att.status === 'present' ? 'P' : att.status === 'late' ? 'L' : 'A';
        return {
          date: d,
          tag,
          status: att.status,
          checkInTime: formatTime(att.check_in_time),
          checkOutTime: out ? formatTime(out.check_out_time) : null,
          number: out ? out.number : null,
        };
      }),
    };
  });

  const summary = dates.map((d, i) => {
    let present = 0, late = 0, absent = 0;
    for (const row of rows) {
      const cell = row.cells[i];
      if (!cell || !cell.tag) continue;
      if (cell.tag === 'P') present++;
      else if (cell.tag === 'L') late++;
      else if (cell.tag === 'A') absent++;
    }
    return { present, late, absent };
  });

  return {
    dates,
    dateLabels: dates.map(formatDateLabel),
    rows,
    summary,
  };
}

router.get('/rosters', requireAdmin, (req, res) => {
  const tab = TABS[req.query.tab] ? req.query.tab : `${defaultDay()}-student`;
  const cfg = TABS[tab];
  const rosterId = rosterIdForTab(tab);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  const dates = rosterDates(rosterId);
  const alertDate = todayIfSessionDay(cfg.day);

  res.render('admin-rosters', {
    title: 'Attendance',
    tabs: TABS,
    tab,
    tabLabel: cfg.label,
    dayLabel: DAY_LABELS[cfg.day],
    roster,
    ...buildRosterGridData(roster),
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    alertDate,
    alertDateLabel: alertDate ? formatDateLabel(alertDate) : null,
    absenceAlerts: absenceFormSubmissionsForRoster(rosterId, alertDate),
    classesAtRisk: classesAtRiskForDay(cfg.day, alertDate),
    classesNeedingStaff: classesNeedingStaffForDay(cfg.day),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Session dates ---

router.post('/rosters/:tab/dates/add', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(rosterId, d);
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/rosters/:tab/dates/:date/remove', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const date = req.params.date;
  db.prepare('DELETE FROM roster_dates WHERE roster_id = ? AND session_date = ?').run(rosterId, date);
  db.prepare('DELETE FROM attendance WHERE roster_id = ? AND session_date = ?').run(rosterId, date);
  db.prepare('DELETE FROM checkouts WHERE roster_id = ? AND session_date = ?').run(rosterId, date);
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)} and its attendance records.`));
});

// --- Roster membership ---

router.post('/rosters/:tab/remove-member/:memberId', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, memberId);
  res.redirect(`/admin/rosters?tab=${tab}`);
});

// --- Manual attendance entry ---
// Batches every edited grid cell into one POST (mirrors the Floater
// Assignments position/room grid's Edit/Save pattern) - each key looks
// like status:<memberId>:<date>, value is 'present'/'late'/'absent'/''
// (blank clears the cell). Entries made here are tagged source='manual'
// so they're distinguishable from real kiosk scans.
router.post('/rosters/:tab/attendance', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');

  const upsert = db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, source)
     VALUES (?, ?, ?, ?, 'manual')
     ON CONFLICT(member_id, roster_id, session_date) DO UPDATE SET
       status = excluded.status,
       source = 'manual'`
  );
  const clear = db.prepare('DELETE FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?');

  for (const key of Object.keys(req.body)) {
    const match = /^status:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) continue;
    const [, memberId, date] = match;
    const value = (req.body[key] || '').trim();
    if (value === 'present' || value === 'late' || value === 'absent') {
      upsert.run(parseInt(memberId, 10), rosterId, date, value);
    } else {
      clear.run(parseInt(memberId, 10), rosterId, date);
    }
  }

  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent('Attendance saved.'));
});

router.get('/roster/:tab/export.csv', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const cfg = TABS[tab];
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  const data = buildRosterGridData(roster);

  const header = ['Name'];
  for (const d of data.dates) {
    header.push(`${d} Status`, `${d} Check-In`, `${d} Check-Out`, `${d} #`);
  }

  const rowLines = data.rows.map((r) => {
    const row = [r.member.name];
    for (const cell of r.cells) {
      row.push(cell.tag || '', cell.checkInTime || '', cell.checkOutTime || '', cell.number ?? '');
    }
    return toCsvRow(row);
  });

  const summaryRows = ['Present', 'Late', 'Absent'].map((label) => {
    const key = label.toLowerCase();
    const row = [label];
    for (const s of data.summary) {
      row.push(key === 'present' ? s.present : key === 'late' ? s.late : s.absent, '', '', '');
    }
    return toCsvRow(row);
  });

  sendCsv(res, `${cfg.label.replace(/[^a-z0-9]+/gi, '-')}-roster.csv`, [toCsvRow(header), ...rowLines, ...summaryRows]);
});

module.exports = router;
