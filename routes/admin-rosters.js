const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatTime, formatTimestamp, todayISO, weekdayOf } = require('../utils/dates');
const { familyOf, byLastName } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { arrivalDepartureLabels } = require('../utils/schedule');
const {
  ensureDayRoster,
  classesAtRiskForDay,
  classesNeedingStaffForDay,
  allClassesList,
  addManualRosterMember,
} = require('../utils/classSchedule');
const { defaultDay, DAY_LABELS, isValidDay, requireDay } = require('../utils/days');
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
      `SELECT m.name AS name, a.status, a.reason_category AS reasonCategory, a.reason_text AS reasonText
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.roster_id = ? AND a.session_date = ? AND a.source = 'absence_form'`
    )
    .all(rosterId, date)
    .sort(byLastName)
    .map((r) => ({
      memberName: r.name,
      status: r.status,
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
  return {
    absences: rows.filter((r) => r.status === 'absent'),
    lates: rows.filter((r) => r.status === 'late'),
  };
}

// Attendance is 4 always-existing, schedule-driven rosters (membership
// fills in automatically from class enrollment/staffing - see
// utils/classSchedule.js) plus a 5th "Class Rosters" tab that lets an
// admin drill into any one class's own auto-maintained roster
// (classes.roster_id). A class roster's tab key is "class-<id>" rather
// than a fixed TABS entry - see classIdFromTab/rosterIdForTab below.
const TABS = {
  'monday-parent': { day: 'monday', role: 'parent', label: 'Monday Parents' },
  'monday-student': { day: 'monday', role: 'student', label: 'Monday Students' },
  'wednesday-parent': { day: 'wednesday', role: 'parent', label: 'Wednesday Parents' },
  'wednesday-student': { day: 'wednesday', role: 'student', label: 'Wednesday Students' },
};

function classIdFromTab(tab) {
  const m = /^class-(\d+)$/.exec(tab || '');
  return m ? parseInt(m[1], 10) : null;
}

function classRosterInfo(classId) {
  return db
    .prepare(
      `SELECT c.*, h.label AS hourLabel FROM classes c
       JOIN class_schedule_hours h ON h.day = c.day AND h.position = c.hour_position
       WHERE c.id = ?`
    )
    .get(classId);
}

function rosterIdForTab(tab) {
  const classId = classIdFromTab(tab);
  if (classId) {
    const cls = db.prepare('SELECT roster_id FROM classes WHERE id = ?').get(classId);
    return cls ? cls.roster_id : null;
  }
  const cfg = TABS[tab];
  return cfg ? ensureDayRoster(cfg.day, cfg.role) : null;
}

// A class roster only ever holds students (see ensureClassRoster/
// syncClassRosterMembers), so the Add Member picker offers students there
// too - everywhere else it matches whichever role that tab tracks.
function memberTypeForTab(tab) {
  if (classIdFromTab(tab)) return 'student';
  const cfg = TABS[tab];
  return cfg ? cfg.role : null;
}

function availableMembersForRoster(rosterId, memberType) {
  if (!memberType) return [];
  return db
    .prepare(
      `SELECT id, name FROM members WHERE active = 1 AND member_type = ?
       AND id NOT IN (SELECT member_id FROM roster_members WHERE roster_id = ?)`
    )
    .all(memberType, rosterId)
    .sort(byLastName);
}

// Every roster (each weekday's Parent/Student roster, every class's own
// roster) lists members alphabetically by last name, not first - see
// byLastName in utils/members.js.
function rosterMembers(rosterId) {
  return db
    .prepare(
      `SELECT m.*
       FROM members m
       JOIN roster_members rm ON rm.member_id = m.id
       WHERE rm.roster_id = ? AND m.active = 1`
    )
    .all(rosterId)
    .sort(byLastName);
}

function rosterDates(rosterId) {
  return db
    .prepare('SELECT session_date FROM roster_dates WHERE roster_id = ? ORDER BY session_date ASC')
    .all(rosterId)
    .map((r) => r.session_date);
}

// datesOverride lets a class roster borrow its dates from the day's
// Student roster instead of managing its own independent list (see the
// /rosters GET handler below) - attendance itself still lives under the
// class's own roster_id either way, only which dates count as real
// columns changes.
function buildRosterGridData(roster, datesOverride) {
  const dates = datesOverride || rosterDates(roster.id);
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

// --- Roster Archive ---
//
// A day's Parent, Student, and every that-day class's grid can be
// snapshotted (typically at term's end) into one combined, permanent
// record, then cleared so the live Attendance grid starts fresh - see the
// AskUserQuestion-confirmed design decision in the roster_archives schema
// comment. A class's own attendance lives under its own roster_id (not
// the day's Parent/Student rosters - see ensureClassRoster in
// utils/classSchedule.js), and a class's displayed dates are always
// borrowed from the day's Student roster (see the datesOverride used by
// GET /rosters below) - so archiving only the Parent/Student rosters
// would leave every class's attendance orphaned and its dates showing
// empty. Every class meeting that day is archived and cleared right
// alongside Parent/Student for that reason.

// Strips a grid row down to exactly what an archive should keep forever:
// display-ready values baked in by name, not a member_id reference that
// would go stale (or point at nothing) once a member is later edited or
// deleted. Also deliberately drops every sensitive/PII field (medical
// notes, photo, address, phone, email) that buildRosterGridData's row.member
// carries - an attendance archive has no business retaining those
// permanently (see this session's earlier data-retention audit).
function archiveRow(row) {
  return {
    name: row.member.name,
    memberType: row.member.member_type,
    parentName: row.parentName,
    arrivalLabel: row.arrivalLabel,
    departureLabel: row.departureLabel,
    cells: row.cells.map((c) => ({ date: c.date, tag: c.tag, checkInTime: c.checkInTime, checkOutTime: c.checkOutTime, number: c.number })),
  };
}

function archiveGrid(gridData) {
  return {
    dates: gridData.dates,
    dateLabels: gridData.dateLabels,
    rows: gridData.rows.map(archiveRow),
    summary: gridData.summary,
  };
}

// Builds the full self-contained snapshot for one day - Parent, Student,
// and every class meeting that day, each with its own grid (a class's
// dates mirror the Student roster's, same as the live view).
function buildDaySnapshot(day) {
  const parentRosterId = ensureDayRoster(day, 'parent');
  const studentRosterId = ensureDayRoster(day, 'student');
  const parentRoster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(parentRosterId);
  const studentRoster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(studentRosterId);
  const studentDates = rosterDates(studentRosterId);

  const classes = allClassesList(day).map((c) => {
    const classRoster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(c.roster_id);
    return {
      className: c.class_name,
      hourLabel: c.hourLabel,
      gradeLabel: c.gradeLabel,
      timeLabel: c.timeLabel,
      teacherNames: c.teacherNames,
      assistantNames: c.assistantNames,
      ...archiveGrid(buildRosterGridData(classRoster, studentDates)),
    };
  });

  return {
    day,
    parent: { label: TABS[`${day}-parent`].label, ...archiveGrid(buildRosterGridData(parentRoster)) },
    student: { label: TABS[`${day}-student`].label, ...archiveGrid(buildRosterGridData(studentRoster)) },
    classes,
  };
}

// Wipes exactly what buildDaySnapshot just captured for one roster - the
// same three tables dates/:date/remove already clears for a single date
// (see below), just for every date at once.
function clearDayRosterData(rosterId) {
  db.prepare('DELETE FROM roster_dates WHERE roster_id = ?').run(rosterId);
  db.prepare('DELETE FROM attendance WHERE roster_id = ?').run(rosterId);
  db.prepare('DELETE FROM checkouts WHERE roster_id = ?').run(rosterId);
}

// The one write path for the whole archive-and-clear operation - snapshot
// first, then clear, wrapped in a transaction so a mid-operation failure
// can never leave a day half-cleared without ever having been saved.
function archiveDay(day) {
  const snapshot = buildDaySnapshot(day);
  if (snapshot.parent.dates.length === 0 && snapshot.student.dates.length === 0) {
    return { ok: false, message: `${DAY_LABELS[day]} has no session dates to archive yet.` };
  }

  const parentRosterId = ensureDayRoster(day, 'parent');
  const studentRosterId = ensureDayRoster(day, 'student');
  const classRosterIds = allClassesList(day).map((c) => c.roster_id).filter(Boolean);

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO roster_archives (day, data_json) VALUES (?, ?)').run(day, JSON.stringify(snapshot));
    for (const rosterId of [parentRosterId, studentRosterId, ...classRosterIds]) clearDayRosterData(rosterId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ok: true, message: `Archived ${DAY_LABELS[day]} attendance. The live roster has been cleared for a fresh start.` };
}

// One row of the Archive tab's log list - counts only, not the full
// (potentially large) snapshot.
function archiveSummary(row) {
  const data = JSON.parse(row.data_json);
  return {
    id: row.id,
    day: row.day,
    archivedAtLabel: formatTimestamp(row.archived_at),
    dateCount: new Set([...data.parent.dates, ...data.student.dates]).size,
    parentCount: data.parent.rows.length,
    studentCount: data.student.rows.length,
    classCount: data.classes.length,
  };
}

function loadArchive(id) {
  const row = db.prepare('SELECT * FROM roster_archives WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, day: row.day, archivedAtLabel: formatTimestamp(row.archived_at), ...JSON.parse(row.data_json) };
}

router.get('/rosters', requireAdmin, (req, res) => {
  const requestedTab = req.query.tab || '';

  if (requestedTab === 'archive') {
    const dayFilter = isValidDay(req.query.day) ? req.query.day : '';
    const rows = db
      .prepare(`SELECT * FROM roster_archives ${dayFilter ? 'WHERE day = ?' : ''} ORDER BY archived_at DESC`)
      .all(...(dayFilter ? [dayFilter] : []));
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'archive',
      topTab: 'archive',
      view: 'archive',
      archives: rows.map(archiveSummary),
      dayFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (requestedTab === 'classes') {
    const dayFilter = ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '';
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'classes',
      topTab: 'classes',
      view: 'classList',
      classes: allClassesList(dayFilter || null),
      dayFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const classId = classIdFromTab(requestedTab);
  let tab = requestedTab;
  let day;
  let tabLabel;

  if (classId) {
    const cls = classRosterInfo(classId);
    if (!cls) return res.redirect('/admin/rosters?tab=classes');
    day = cls.day;
    tabLabel = `${cls.class_name} (${cls.hourLabel})`;
  } else {
    tab = TABS[requestedTab] ? requestedTab : `${defaultDay()}-student`;
    const cfg = TABS[tab];
    day = cfg.day;
    tabLabel = cfg.label;
  }

  const rosterId = rosterIdForTab(tab);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  // A class roster has no dates of its own to manage - it always mirrors
  // whichever day's Student roster it belongs to (a class only ever
  // meets when that day's students do), so there's no separate Edit
  // Dates step for it (see the view - Edit Dates/+ Add Member are hidden
  // whenever classId is set).
  const dates = classId ? rosterDates(ensureDayRoster(day, 'student')) : rosterDates(rosterId);
  const alertDate = todayIfSessionDay(day);

  res.render('admin-rosters', {
    title: 'Attendance',
    tab,
    topTab: classId ? 'classes' : day,
    view: 'grid',
    classId,
    day,
    tabLabel,
    dayLabel: DAY_LABELS[day],
    roster,
    ...buildRosterGridData(roster, classId ? dates : undefined),
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    alertDate,
    alertDateLabel: alertDate ? formatDateLabel(alertDate) : null,
    absenceAlerts: absenceFormSubmissionsForRoster(rosterId, alertDate),
    classesAtRisk: classesAtRiskForDay(day, alertDate),
    classesNeedingStaff: classesNeedingStaffForDay(day),
    availableMembers: availableMembersForRoster(rosterId, memberTypeForTab(tab)),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Session dates ---

// Parents and students at the same co-op session meet on the same actual
// calendar dates - there's no such thing as a Monday that students have
// but parents don't. So a session date always applies to BOTH the
// Parent and Student rosters for that day, not just whichever tab it was
// added from. Without this, a date added only to "Monday Students" (the
// common case, since that's what daily check-in cares about) left the
// "Monday Parents" roster without that date - so a teaching parent
// reporting their own absence via the public form would be told they
// "aren't on any roster" for a date their own kids' roster had just fine.
function siblingRosterId(tab) {
  const info = TABS[tab];
  if (!info) return null;
  const otherRole = info.role === 'parent' ? 'student' : 'parent';
  return ensureDayRoster(info.day, otherRole);
}

router.post('/rosters/:tab/dates/add', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)');
  const siblingId = siblingRosterId(tab);
  for (const d of dates) {
    insertDate.run(rosterId, d);
    if (siblingId) insertDate.run(siblingId, d);
  }
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/rosters/:tab/dates/:date/remove', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const date = req.params.date;
  const rosterIds = [rosterId, siblingRosterId(tab)].filter(Boolean);
  const placeholders = rosterIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM roster_dates WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
  db.prepare(`DELETE FROM attendance WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
  db.prepare(`DELETE FROM checkouts WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)} and its attendance records.`));
});

// --- Roster membership ---

router.post('/rosters/:tab/add-member', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  memberIds.forEach((memberId) => addManualRosterMember(rosterId, memberId));
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${memberIds.length} member(s).`));
});

router.post('/rosters/:tab/remove-member/:memberId', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, memberId);
  res.redirect(`/admin/rosters?tab=${tab}`);
});

// --- Manual attendance entry ---
// Cells auto-save one at a time on change (public/js/attendance-grid.js) -
// each request carries a single status:<memberId>:<date> key, value is
// 'present'/'late'/'absent'/'' (blank clears the cell). Entries made here
// are tagged source='manual' so they're distinguishable from real kiosk
// scans.
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

  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent('Attendance saved.'));
});

// --- Archive routes ---

router.post('/rosters/:day/archive', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const result = archiveDay(day);
  const query = result.ok
    ? `notice=${encodeURIComponent(result.message)}`
    : `error=${encodeURIComponent(result.message)}`;
  res.redirect(`/admin/rosters?tab=${day}-student&${query}`);
});

router.get('/rosters/archive/:id/view-fragment', requireAdmin, (req, res) => {
  const archive = loadArchive(parseInt(req.params.id, 10));
  if (!archive) return res.status(404).send('Not found');
  res.render('roster-archive-view-fragment', { archive, dayLabel: DAY_LABELS[archive.day] });
});

router.get('/rosters/archive/:id/print', requireAdmin, (req, res) => {
  const archive = loadArchive(parseInt(req.params.id, 10));
  if (!archive) return res.status(404).send('Not found');
  res.render('admin-rosters-archive-print', {
    title: `${DAY_LABELS[archive.day]} Attendance Archive — ${archive.archivedAtLabel}`,
    archive,
    dayLabel: DAY_LABELS[archive.day],
  });
});

// One combined CSV: each of Parent/Student/every class gets its own
// labeled section, in the same Name + per-date Status/Check-In/Check-Out/#
// column shape the live roster export already uses.
function gridCsvSection(sectionLabel, grid) {
  const header = ['Name'];
  for (const d of grid.dates) header.push(`${d} Status`, `${d} Check-In`, `${d} Check-Out`, `${d} #`);

  const rowLines = grid.rows.map((r) => {
    const row = [r.name];
    for (const cell of r.cells) row.push(cell.tag || '', cell.checkInTime || '', cell.checkOutTime || '', cell.number ?? '');
    return toCsvRow(row);
  });

  const summaryRows = ['Present', 'Late', 'Absent'].map((label) => {
    const key = label.toLowerCase();
    const row = [label];
    for (const s of grid.summary) row.push(key === 'present' ? s.present : key === 'late' ? s.late : s.absent, '', '', '');
    return toCsvRow(row);
  });

  return [toCsvRow([sectionLabel]), toCsvRow(header), ...rowLines, ...summaryRows, toCsvRow([])];
}

router.get('/rosters/archive/:id/export.csv', requireAdmin, (req, res) => {
  const archive = loadArchive(parseInt(req.params.id, 10));
  if (!archive) return res.status(404).send('Not found');

  const lines = [
    ...gridCsvSection(archive.parent.label, archive.parent),
    ...gridCsvSection(archive.student.label, archive.student),
    ...archive.classes.flatMap((c) => gridCsvSection(`${c.className} (${c.hourLabel})`, c)),
  ];

  sendCsv(res, `${archive.day}-attendance-archive-${archive.id}.csv`, lines);
});

router.get('/roster/:tab/export.csv', requireAdmin, (req, res) => {
  const tab = req.params.tab;
  const classId = classIdFromTab(tab);
  const label = classId ? (classRosterInfo(classId) || {}).class_name : (TABS[tab] || {}).label;
  const rosterId = rosterIdForTab(tab);
  if (!rosterId || !label) return res.status(404).send('Not found');
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

  sendCsv(res, `${label.replace(/[^a-z0-9]+/gi, '-')}-roster.csv`, [toCsvRow(header), ...rowLines, ...summaryRows]);
});

module.exports = router;
