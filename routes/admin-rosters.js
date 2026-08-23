const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatTimestamp, todayISO, weekdayOf } = require('../utils/dates');
const { byLastName } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const {
  ensureDayRoster,
  classesAtRiskForDay,
  classesNeedingStaffForDay,
  allClassesList,
  addManualRosterMember,
  syncDayMemberRosters,
  classRosterIdsForDay,
  HOUR_POSITIONS,
} = require('../utils/classSchedule');
const { defaultDay, DAYS, DAY_LABELS, isValidDay, requireDay } = require('../utils/days');
const { REASON_LABELS } = require('../utils/rosters');
const { rosterDates, buildRosterGridData } = require('../utils/rosterGrid');
const { ensurePlaygroundRoster, playgroundHourLabel, playgroundLogForDate } = require('../utils/playground');

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
async function absenceFormSubmissionsForRoster(rosterId, date) {
  if (!date) return { absences: [], lates: [] };
  const rows = (await db
    .prepare(
      `SELECT m.name AS name, a.status, a.reason_category AS "reasonCategory", a.reason_text AS "reasonText"
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.roster_id = ? AND a.session_date = ? AND a.source = 'absence_form'`
    )
    .all(rosterId, date))
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

async function classRosterInfo(classId) {
  return db
    .prepare(
      `SELECT c.*, h.label AS "hourLabel" FROM classes c
       JOIN class_schedule_hours h ON h.day = c.day AND h.position = c.hour_position
       WHERE c.id = ?`
    )
    .get(classId);
}

async function rosterIdForTab(tab) {
  const classId = classIdFromTab(tab);
  if (classId) {
    const cls = await db.prepare('SELECT roster_id FROM classes WHERE id = ?').get(classId);
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

async function availableMembersForRoster(rosterId, memberType) {
  if (!memberType) return [];
  return (await db
    .prepare(
      `SELECT id, name FROM members WHERE active = 1 AND member_type = ?
       AND id NOT IN (SELECT member_id FROM roster_members WHERE roster_id = ?)`
    )
    .all(memberType, rosterId))
    .sort(byLastName);
}

// rosterMembers/rosterDates/buildRosterGridData now live in
// utils/rosterGrid.js, shared with the kiosk's Class Check-In "View
// Class Attendance" screen (routes/kiosk-class-checkin.js).

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
    cells: row.cells.map((c) => ({
      date: c.date,
      tag: c.tag,
      checkInTime: c.checkInTime,
      checkOutTime: c.checkOutTime,
      number: c.number,
      cleanupTaskNumber: c.cleanupTaskNumber,
    })),
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
async function buildDaySnapshot(day) {
  const parentRosterId = await ensureDayRoster(day, 'parent');
  const studentRosterId = await ensureDayRoster(day, 'student');
  const parentRoster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(parentRosterId);
  const studentRoster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(studentRosterId);
  const studentDates = await rosterDates(studentRosterId);

  const classes = [];
  for (const c of await allClassesList(day)) {
    // roster_id is nullable (ON DELETE SET NULL, and not filled in until
    // ensureClassRoster's first call for this class - see archiveDay
    // below's own classRosterIds .filter(Boolean) for the same gap) - a
    // class with no roster yet has nothing to snapshot.
    if (!c.roster_id) continue;
    const classRoster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(c.roster_id);
    if (!classRoster) continue;
    classes.push({
      className: c.class_name,
      hourLabel: c.hourLabel,
      gradeLabel: c.gradeLabel,
      timeLabel: c.timeLabel,
      teacherNames: c.teacherNames,
      assistantNames: c.assistantNames,
      ...archiveGrid(await buildRosterGridData(classRoster, studentDates)),
    });
  }

  return {
    day,
    parent: { label: TABS[`${day}-parent`].label, ...archiveGrid(await buildRosterGridData(parentRoster)) },
    student: { label: TABS[`${day}-student`].label, ...archiveGrid(await buildRosterGridData(studentRoster)) },
    classes,
  };
}

// Wipes exactly what buildDaySnapshot just captured for one roster - the
// same three tables dates/:date/remove already clears for a single date
// (see below), just for every date at once. Takes the transaction's own
// tx handle (see archiveDay below) rather than the outer db, so every
// query here runs on the same connection that issued BEGIN.
async function clearDayRosterData(tx, rosterId) {
  await tx.prepare('DELETE FROM roster_dates WHERE roster_id = ?').run(rosterId);
  await tx.prepare('DELETE FROM attendance WHERE roster_id = ?').run(rosterId);
  await tx.prepare('DELETE FROM checkouts WHERE roster_id = ?').run(rosterId);
}

// The one write path for the whole archive-and-clear operation - snapshot
// first, then clear, wrapped in a transaction so a mid-operation failure
// can never leave a day half-cleared without ever having been saved.
async function archiveDay(day) {
  const snapshot = await buildDaySnapshot(day);
  if (snapshot.parent.dates.length === 0 && snapshot.student.dates.length === 0) {
    return { ok: false, message: `${DAY_LABELS[day]} has no session dates to archive yet.` };
  }

  const parentRosterId = await ensureDayRoster(day, 'parent');
  const studentRosterId = await ensureDayRoster(day, 'student');
  const classRosterIds = (await allClassesList(day)).map((c) => c.roster_id).filter(Boolean);

  await db.withTransaction(async (tx) => {
    await tx.prepare('INSERT INTO roster_archives (day, data_json) VALUES (?, ?)').run(day, JSON.stringify(snapshot));
    for (const rosterId of [parentRosterId, studentRosterId, ...classRosterIds]) await clearDayRosterData(tx, rosterId);
  });

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

async function loadArchive(id) {
  const row = await db.prepare('SELECT * FROM roster_archives WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, day: row.day, archivedAtLabel: formatTimestamp(row.archived_at), ...JSON.parse(row.data_json) };
}

router.get('/rosters', requireAdmin, async (req, res) => {
  const requestedTab = req.query.tab || '';

  if (requestedTab === 'archive') {
    const dayFilter = isValidDay(req.query.day) ? req.query.day : '';
    const rows = await db
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
    const hourFilter = HOUR_POSITIONS.includes(parseInt(req.query.hour, 10)) ? parseInt(req.query.hour, 10) : null;
    let classes = await allClassesList(dayFilter || null);
    // Filtered here rather than in allClassesList() itself (its two other
    // callers - buildDaySnapshot and clearDayRosterData's own roster-id
    // lookup - have no concept of "hour" to filter by) - by hour_position
    // (the 1-4 slot number), not hourLabel's display text, since that
    // text is per-day-configurable (class_schedule_hours) and can differ
    // between Monday's and Wednesday's own "Hour 1", while this filter
    // needs to mean the same hour regardless of which day(s) are shown.
    if (hourFilter) classes = classes.filter((c) => c.hour_position === hourFilter);
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'classes',
      topTab: 'classes',
      view: 'classList',
      classes,
      dayFilter,
      hourFilter,
      hourPositions: HOUR_POSITIONS,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Playground: an open drop-in log with no fixed roster - "anybody can
  // check in and out of the playground" - so unlike Classes (a list of
  // real `classes` rows), there's nothing to list except the 8 fixed
  // (day, hour) slots themselves. Each links to its own tab key
  // ("playground-monday-1", mirroring "class-<id>" above), which the
  // regex just below matches against.
  if (requestedTab === 'playground') {
    const entries = [];
    for (const day of DAYS) {
      for (const hour of HOUR_POSITIONS) {
        entries.push({ day, hour, dayLabel: DAY_LABELS[day], hourLabel: await playgroundHourLabel(day, hour) });
      }
    }
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'playground',
      topTab: 'playground',
      view: 'playgroundList',
      playgroundEntries: entries,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const playgroundMatch = /^playground-(monday|wednesday)-([1-4])$/.exec(requestedTab);
  if (playgroundMatch) {
    const pgDay = playgroundMatch[1];
    const pgHour = parseInt(playgroundMatch[2], 10);
    const rosterId = await ensurePlaygroundRoster(pgDay, pgHour);
    // A playground slot borrows its session dates from the day's Student
    // roster, same reasoning as a class roster (utils/classSchedule.js's
    // ensureClassRoster) - playground runs during the same sessions
    // classes do, so there's no such thing as a session date the day's
    // students have that playground doesn't, or vice versa. Read live
    // rather than stored, so there's no separate Edit Dates step to keep
    // in sync (unlike a class roster's own roster_dates rows).
    const studentRosterId = await ensureDayRoster(pgDay, 'student');
    const pgDates = await rosterDates(studentRosterId);
    const today = todayISO();
    const requestedDate = isValidISODate(req.query.date) && pgDates.includes(req.query.date) ? req.query.date : null;
    const selectedDate = requestedDate || [...pgDates].reverse().find((d) => d <= today) || pgDates[pgDates.length - 1] || null;
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: requestedTab,
      topTab: 'playground',
      view: 'playgroundLog',
      pgDay,
      pgHour,
      pgDayLabel: DAY_LABELS[pgDay],
      pgHourLabel: await playgroundHourLabel(pgDay, pgHour),
      pgDates: pgDates.map((d) => ({ date: d, label: formatDateLabel(d) })),
      selectedDate,
      selectedDateLabel: selectedDate ? formatDateLabel(selectedDate) : null,
      log: selectedDate ? await playgroundLogForDate(rosterId, selectedDate) : [],
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const classId = classIdFromTab(requestedTab);
  let tab = requestedTab;
  let day;
  let tabLabel;

  if (classId) {
    const cls = await classRosterInfo(classId);
    if (!cls) return res.redirect('/admin/rosters?tab=classes');
    day = cls.day;
    tabLabel = `${cls.class_name} (${cls.hourLabel})`;
  } else {
    tab = TABS[requestedTab] ? requestedTab : `${defaultDay()}-student`;
    const cfg = TABS[tab];
    day = cfg.day;
    tabLabel = cfg.label;
  }

  const rosterId = await rosterIdForTab(tab);
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  // rosterIdForTab returns a class's roster_id verbatim for a class tab,
  // which is nullable (ON DELETE SET NULL, and not filled in until
  // ensureClassRoster's first call for this class) - classRosterInfo above
  // only proves the class itself exists, not that it has a roster yet.
  if (!roster) return res.redirect('/admin/rosters?tab=classes');
  // A class roster has no dates of its own to manage - it always mirrors
  // whichever day's Student roster it belongs to (a class only ever
  // meets when that day's students do), so there's no separate Edit
  // Dates step for it (see the view - Edit Dates/+ Add Member are hidden
  // whenever classId is set).
  const dates = classId ? await rosterDates(await ensureDayRoster(day, 'student')) : await rosterDates(rosterId);
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
    ...(await buildRosterGridData(roster, classId ? dates : undefined)),
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    alertDate,
    alertDateLabel: alertDate ? formatDateLabel(alertDate) : null,
    // The Alerts section below the grid is Parent/Student-roster-only (a
    // class roster mirrors its day's Student roster's session dates and
    // has no day-level "who needs a sub/is at risk" concept of its own -
    // see the view), so skip computing it for a class tab entirely.
    absenceAlerts: classId ? null : await absenceFormSubmissionsForRoster(rosterId, alertDate),
    classesAtRisk: classId ? null : await classesAtRiskForDay(day, alertDate),
    classesNeedingStaff: classId ? null : await classesNeedingStaffForDay(day, alertDate),
    availableMembers: await availableMembersForRoster(rosterId, memberTypeForTab(tab)),
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
async function siblingRosterId(tab) {
  const info = TABS[tab];
  if (!info) return null;
  const otherRole = info.role === 'parent' ? 'student' : 'parent';
  return ensureDayRoster(info.day, otherRole);
}

// A real request: every class meeting a given day should show the same
// session dates as that day's Parent/Student rosters - a class only ever
// meets when that day's students do, so there's no such thing as a
// Monday the main rosters have that a Monday class doesn't. Mirrors
// siblingRosterId's own reasoning above, just for every class roster on
// the day instead of one sibling roster (see utils/classSchedule.js's
// ensureClassRoster/backfillClassRosterDates for the other two places
// this same invariant is kept - a class created after dates already
// exist, and an already-deployed database's existing classes).
async function dayClassRosterIds(tab) {
  const info = TABS[tab];
  return info ? classRosterIdsForDay(info.day) : [];
}

router.post('/rosters/:tab/dates/add', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare(
    'INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING'
  );
  const siblingId = await siblingRosterId(tab);
  const classRosterIds = await dayClassRosterIds(tab);
  for (const d of dates) {
    await insertDate.run(rosterId, d);
    if (siblingId) await insertDate.run(siblingId, d);
    for (const classRosterId of classRosterIds) await insertDate.run(classRosterId, d);
  }
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/rosters/:tab/dates/:date/remove', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const date = req.params.date;
  const rosterIds = [rosterId, await siblingRosterId(tab), ...(await dayClassRosterIds(tab))].filter(Boolean);
  const placeholders = rosterIds.map(() => '?').join(',');
  await db.withTransaction(async (tx) => {
    await tx.prepare(`DELETE FROM roster_dates WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
    await tx.prepare(`DELETE FROM attendance WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
    await tx.prepare(`DELETE FROM checkouts WHERE roster_id IN (${placeholders}) AND session_date = ?`).run(...rosterIds, date);
  });
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)} and its attendance records.`));
});

// --- Roster membership ---

router.post('/rosters/:tab/add-member', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  for (const memberId of memberIds) await addManualRosterMember(rosterId, memberId);
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${memberIds.length} member(s).`));
});

router.post('/rosters/:tab/remove-member/:memberId', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberId = parseInt(req.params.memberId, 10);
  await db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, memberId);
  res.redirect(`/admin/rosters?tab=${tab}`);
});

// --- Manual attendance entry ---
// Cells auto-save one at a time on change (public/js/attendance-grid.js) -
// each request carries a single status:<memberId>:<date> key, value is
// 'present'/'late'/'absent'/'' (blank clears the cell). Entries made here
// are tagged source='manual' so they're distinguishable from real kiosk
// scans.
router.post('/rosters/:tab/attendance', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
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
      await upsert.run(parseInt(memberId, 10), rosterId, date, value);
    } else {
      await clear.run(parseInt(memberId, 10), rosterId, date);
    }
  }

  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent('Attendance saved.'));
});

// Re-runs syncDayMemberRosters(day) on demand instead of only reactively
// on the next enrollment/staffing/floater edit - this is normally
// automatic (see that function's own comment), but a family whose
// roster/floater membership went stale under old logic before a fix
// landed has no reason to get touched again on its own, so this gives an
// admin a way to force it without making a throwaway edit. Auto-added
// ('source'='auto') roster members not in the freshly computed set are
// removed; anyone added by hand via + Add Member is untouched either way.
router.post('/rosters/:day/resync', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  await syncDayMemberRosters(day);
  const tab = req.body.tab && TABS[req.body.tab] && TABS[req.body.tab].day === day ? req.body.tab : `${day}-student`;
  res.redirect(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`${DAY_LABELS[day]} rosters resynced.`));
});

// --- Archive routes ---

router.post('/rosters/:day/archive', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const result = await archiveDay(day);
  const query = result.ok
    ? `notice=${encodeURIComponent(result.message)}`
    : `error=${encodeURIComponent(result.message)}`;
  res.redirect(`/admin/rosters?tab=${day}-student&${query}`);
});

router.get('/rosters/archive/:id/view-fragment', requireAdmin, async (req, res) => {
  const archive = await loadArchive(parseInt(req.params.id, 10));
  if (!archive) return res.status(404).send('Not found');
  res.render('roster-archive-view-fragment', { archive, dayLabel: DAY_LABELS[archive.day] });
});

router.get('/rosters/archive/:id/print', requireAdmin, async (req, res) => {
  const archive = await loadArchive(parseInt(req.params.id, 10));
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
  for (const d of grid.dates) header.push(`${d} Status`, `${d} Check-In`, `${d} Check-Out`, `${d} #`, `${d} Cleanup #`);

  const rowLines = grid.rows.map((r) => {
    const row = [r.name];
    for (const cell of r.cells) row.push(cell.tag || '', cell.checkInTime || '', cell.checkOutTime || '', cell.number ?? '', cell.cleanupTaskNumber ?? '');
    return toCsvRow(row);
  });

  const summaryRows = ['Present', 'Late', 'Absent'].map((label) => {
    const key = label.toLowerCase();
    const row = [label];
    for (const s of grid.summary) row.push(key === 'present' ? s.present : key === 'late' ? s.late : s.absent, '', '', '', '');
    return toCsvRow(row);
  });

  return [toCsvRow([sectionLabel]), toCsvRow(header), ...rowLines, ...summaryRows, toCsvRow([])];
}

router.get('/rosters/archive/:id/export.csv', requireAdmin, async (req, res) => {
  const archive = await loadArchive(parseInt(req.params.id, 10));
  if (!archive) return res.status(404).send('Not found');

  const lines = [
    ...gridCsvSection(archive.parent.label, archive.parent),
    ...gridCsvSection(archive.student.label, archive.student),
    ...archive.classes.flatMap((c) => gridCsvSection(`${c.className} (${c.hourLabel})`, c)),
  ];

  sendCsv(res, `${archive.day}-attendance-archive-${archive.id}.csv`, lines);
});

router.get('/roster/:tab/export.csv', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const classId = classIdFromTab(tab);
  const label = classId ? ((await classRosterInfo(classId)) || {}).class_name : (TABS[tab] || {}).label;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId || !label) return res.status(404).send('Not found');
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  const data = await buildRosterGridData(roster);

  const header = ['Name'];
  for (const d of data.dates) {
    header.push(`${d} Status`, `${d} Check-In`, `${d} Check-Out`, `${d} #`, `${d} Cleanup #`);
  }

  const rowLines = data.rows.map((r) => {
    const row = [r.member.name];
    for (const cell of r.cells) {
      row.push(cell.tag || '', cell.checkInTime || '', cell.checkOutTime || '', cell.number ?? '', cell.cleanupTaskNumber ?? '');
    }
    return toCsvRow(row);
  });

  const summaryRows = ['Present', 'Late', 'Absent'].map((label) => {
    const key = label.toLowerCase();
    const row = [label];
    for (const s of data.summary) {
      row.push(key === 'present' ? s.present : key === 'late' ? s.late : s.absent, '', '', '', '');
    }
    return toCsvRow(row);
  });

  sendCsv(res, `${label.replace(/[^a-z0-9]+/gi, '-')}-roster.csv`, [toCsvRow(header), ...rowLines, ...summaryRows]);
});

module.exports = router;
