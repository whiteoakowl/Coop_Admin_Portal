const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, todayISO, weekdayOf } = require('../utils/dates');
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
  listSemesters,
  CLASS_DAYS,
  CLASS_DAY_LABELS_FULL,
  CLASS_DAY_WEEKDAY_FULL,
  requireClassDay,
  listActiveClassDays,
  listScheduleCombos,
} = require('../utils/classSchedule');
const { comboSemesterId, qsSemester, appendSemester, findComboId } = require('../utils/scheduleComboLinks');
const { getActiveKioskSemesterId } = require('../utils/kioskSettings');
const { absenceFormSubmissionsForRoster } = require('../utils/alerts');
const { rosterDates, buildRosterGridData } = require('../utils/rosterGrid');
const { ensurePlaygroundRoster, playgroundHourLabel, playgroundLogForDate } = require('../utils/playground');

// Mirrors routes/admin-schedule.js's own resolveSemesterId - Attendance's
// Parent/Student rosters, like Classes' own grid, have no single
// authoritative row of their own to read an effective semester_id back
// off (unlike Floater/Setup-Cleanup's semester-scoped lists), so an
// unspecified ?semesterId= falls back to the site-wide active Kiosk
// semester same as everywhere else that convention already applies.
async function resolveSemesterId(semesterId) {
  return semesterId !== undefined ? semesterId : await getActiveKioskSemesterId();
}

// A real request: "Full 7 day expansion so... attendance... will work for
// years to come" - the Day Settings-driven 7-day Classes grid (utils/
// classDays.js's CLASS_DAYS/CLASS_DAY_LABELS_FULL/requireClassDay) now
// backs Attendance too, in place of utils/days.js's own older,
// Monday/Wednesday-only DAYS/DAY_LABELS/isValidDay/requireDay - same
// migration Floater Assignments and Setup/Cleanup already made.

// The alert log below the grid only makes sense for today, and only when
// today is actually a session day for this roster's day-of-week (mirrors
// the Floater Assignments Substitutes board's same-shaped default).
function todayIfSessionDay(day) {
  const today = todayISO();
  return weekdayOf(today) === CLASS_DAY_WEEKDAY_FULL[day] ? today : null;
}

// Attendance is a pair of always-existing, schedule-driven Parent/Student
// rosters per active day (membership fills in automatically from class
// enrollment/staffing - see utils/classSchedule.js) plus a "Class
// Rosters" tab that lets an admin drill into any one class's own
// auto-maintained roster (classes.roster_id). A class roster's tab key is
// "class-<id>" rather than a "<day>-<role>" one - see classIdFromTab/
// rosterIdForTab below. Unlike the old 2-day TABS lookup object, tabInfo
// is a pure function - any of the 7 canonical days works structurally,
// not just whichever ones happen to be "active" (Day Settings) right now,
// same as classIdFromTab's own regex match just below.
function tabInfo(tab) {
  const m = /^([a-z]+)-(parent|student)$/.exec(tab || '');
  if (!m || !CLASS_DAYS.includes(m[1])) return null;
  const day = m[1];
  const role = m[2];
  return { day, role, label: `${CLASS_DAY_LABELS_FULL[day]} ${role === 'parent' ? 'Parents' : 'Students'}` };
}

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
  const cfg = tabInfo(tab);
  return cfg ? ensureDayRoster(cfg.day, cfg.role) : null;
}

// A class roster only ever holds students (see ensureClassRoster/
// syncClassRosterMembers), so the Add Member picker offers students there
// too - everywhere else it matches whichever role that tab tracks.
function memberTypeForTab(tab) {
  if (classIdFromTab(tab)) return 'student';
  const cfg = tabInfo(tab);
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
      cleanupTeamName: c.cleanupTeamName,
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

router.get('/rosters', requireAdmin, async (req, res) => {
  const requestedTab = req.query.tab || '';
  const activeDays = await listActiveClassDays();

  if (requestedTab === 'classes') {
    const dayFilter = activeDays.includes(req.query.day) ? req.query.day : '';
    const hourFilter = HOUR_POSITIONS.includes(parseInt(req.query.hour, 10)) ? parseInt(req.query.hour, 10) : null;
    // A real request: "add semester choice dropdown settings to...
    // Monday/Wednesday attendance" - same optional filter the Classes
    // page itself offers, applied here the same way Hour already is
    // (allClassesList has no semester concept of its own either).
    const semesterFilter = req.query.semesterId || '';
    let classes = await allClassesList(dayFilter || null);
    // Filtered here rather than in allClassesList() itself (its two other
    // callers - buildDaySnapshot and clearDayRosterData's own roster-id
    // lookup - have no concept of "hour" to filter by) - by hour_position
    // (the 1-4 slot number), not hourLabel's display text, since that
    // text is per-day-configurable (class_schedule_hours) and can differ
    // between Monday's and Wednesday's own "Hour 1", while this filter
    // needs to mean the same hour regardless of which day(s) are shown.
    if (hourFilter) classes = classes.filter((c) => c.hour_position === hourFilter);
    if (semesterFilter === 'none') classes = classes.filter((c) => c.semester_id == null);
    else if (semesterFilter) classes = classes.filter((c) => String(c.semester_id) === semesterFilter);
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'classes',
      topTab: 'classes',
      view: 'classList',
      classes,
      dayFilter,
      activeDays,
      dayLabels: CLASS_DAY_LABELS_FULL,
      hourFilter,
      semesterFilter,
      semesters: await listSemesters(),
      hourPositions: HOUR_POSITIONS,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Playground: an open drop-in log with no fixed roster - "anybody can
  // check in and out of the playground" - so unlike Classes (a list of
  // real `classes` rows), there's nothing to list except each active
  // day's own 4 fixed hour slots. Each links to its own tab key
  // ("playground-monday-1", mirroring "class-<id>" above), which the
  // regex just below matches against.
  if (requestedTab === 'playground') {
    const entries = [];
    for (const day of activeDays) {
      for (const hour of HOUR_POSITIONS) {
        entries.push({ day, hour, dayLabel: CLASS_DAY_LABELS_FULL[day], hourLabel: await playgroundHourLabel(day, hour) });
      }
    }
    return res.render('admin-rosters', {
      title: 'Attendance',
      tab: 'playground',
      topTab: 'playground',
      view: 'playgroundList',
      playgroundEntries: entries,
      activeDays,
      dayLabels: CLASS_DAY_LABELS_FULL,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const playgroundMatch = new RegExp(`^playground-(${CLASS_DAYS.join('|')})-([1-4])$`).exec(requestedTab);
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
      pgDayLabel: CLASS_DAY_LABELS_FULL[pgDay],
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
  let role = null;

  if (classId) {
    const cls = await classRosterInfo(classId);
    if (!cls) return res.redirect('/admin/rosters?tab=classes');
    day = cls.day;
    tabLabel = `${cls.class_name} (${cls.hourLabel})`;
  } else {
    // A real request: "have it land on the parent roster each time you
    // click the attendance tab. currently it always lands on student
    // roster" - the nav's own Attendance link (partials/admin-nav.ejs)
    // has no ?tab= at all, so this fallback is what every plain click
    // into Attendance actually lands on. activeDays[0] mirrors Classes'
    // own default-tab fallback (routes/admin-schedule.js).
    const defaultDay = activeDays[0] || 'monday';
    tab = tabInfo(requestedTab) ? requestedTab : `${defaultDay}-parent`;
    const cfg = tabInfo(tab);
    day = cfg.day;
    tabLabel = cfg.label;
    role = cfg.role;
  }

  // A real request: "I need to be able to switch between semester views
  // on floaters, setup cleanup, attendance, classes etc." - same combo
  // picker Floater/Setup-Cleanup/Classes already got, applied to the
  // Parent/Student grid view only (Class Rosters already has its own
  // Day/Hour/Semester filters above). semesterId is a view-only choice
  // threaded through for URL consistency with those other pages - like
  // Classes' own grid, Attendance's roster data has no semester concept
  // of its own to actually filter by.
  const combos = classId ? null : await listScheduleCombos();
  const resolvedSemesterId = classId ? null : await resolveSemesterId(comboSemesterId(req));
  const selectedSemesterId = classId ? null : qsSemester(resolvedSemesterId);

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
    role,
    tabLabel,
    dayLabel: CLASS_DAY_LABELS_FULL[day],
    roster,
    combos,
    selectedComboId: classId ? null : findComboId(combos, day, resolvedSemesterId),
    selectedSemesterId,
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

// A real request: "make sure there is a print preview for all attendance
// print pages" - the grid and Playground log Print buttons above used to
// call window.print() directly on the live, editable page (no review
// step, and printing every editable control's own dropdown/icon chrome
// right along with the data) - every other print button in this app
// already lands on a dedicated, read-only preview page first (see e.g.
// routes/admin-setup.js's own /teams/print). One combined route for
// both shapes (day/class grid, and a Playground hour's log) since they
// share the same admin-rosters-print view, branching the same way the
// live page's own view === 'grid' | 'playgroundLog' already does.
//
// A real follow-up request: "attendance printing the roster can stretch
// to two pages so the font can be 12 point" - unlike the live page's own
// data-shrink-to-fit-on-print (public/js/print-shrink-to-fit.js), which
// scales the WHOLE grid down to guarantee exactly one page, this preview
// starts every page at a fixed, comfortably readable 12pt (see the
// .attendance-print-page rule in styles.css) and only shrinks a given
// 50-row page from there if it still doesn't fit - see the "grid" branch
// below for how pages are split.
router.get('/rosters/print', requireAdmin, async (req, res) => {
  const requestedTab = req.query.tab || '';

  const playgroundMatch = new RegExp(`^playground-(${CLASS_DAYS.join('|')})-([1-4])$`).exec(requestedTab);
  if (playgroundMatch) {
    const pgDay = playgroundMatch[1];
    const pgHour = parseInt(playgroundMatch[2], 10);
    const rosterId = await ensurePlaygroundRoster(pgDay, pgHour);
    const studentRosterId = await ensureDayRoster(pgDay, 'student');
    const pgDates = await rosterDates(studentRosterId);
    const today = todayISO();
    const requestedDate = isValidISODate(req.query.date) && pgDates.includes(req.query.date) ? req.query.date : null;
    const selectedDate = requestedDate || [...pgDates].reverse().find((d) => d <= today) || pgDates[pgDates.length - 1] || null;
    return res.render('admin-rosters-print', {
      title: `${CLASS_DAY_LABELS_FULL[pgDay]} Playground Print Preview`,
      view: 'playgroundLog',
      pgDayLabel: CLASS_DAY_LABELS_FULL[pgDay],
      pgHourLabel: await playgroundHourLabel(pgDay, pgHour),
      selectedDate,
      selectedDateLabel: selectedDate ? formatDateLabel(selectedDate) : null,
      log: selectedDate ? await playgroundLogForDate(rosterId, selectedDate) : [],
    });
  }

  const classId = classIdFromTab(requestedTab);
  let tab = requestedTab;
  let day;
  let tabLabel;
  if (classId) {
    const cls = await classRosterInfo(classId);
    if (!cls) return res.status(404).render('404', { title: 'Not Found' });
    day = cls.day;
    tabLabel = `${cls.class_name} (${cls.hourLabel})`;
  } else {
    const activeDays = await listActiveClassDays();
    const defaultDay = activeDays[0] || 'monday';
    tab = tabInfo(requestedTab) ? requestedTab : `${defaultDay}-parent`;
    const cfg = tabInfo(tab);
    day = cfg.day;
    tabLabel = cfg.label;
  }

  const rosterId = await rosterIdForTab(tab);
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  if (!roster) return res.status(404).render('404', { title: 'Not Found' });
  const dates = classId ? await rosterDates(await ensureDayRoster(day, 'student')) : await rosterDates(rosterId);

  // partials/roster-archive-grid-table expects the flattened { name, ... }
  // row shape archiveGrid builds (row.member.name -> row.name, and a PII
  // strip - no reason a printed attendance sheet needs medical notes/
  // photo/address/phone/email either), not buildRosterGridData's own
  // live { member: {...}, ... } shape - same helper, reused as-is.
  const grid = archiveGrid(await buildRosterGridData(roster, classId ? dates : undefined));

  // A real request: "printing skips the first page. width should fit to
  // page. height should shrink to fit attendance 50 per page." A big
  // day-level roster (dozens of members) used to render as ONE unbounded
  // <table> with no shrink-to-fit at all (a deliberate earlier choice -
  // see this route's own comment above - to avoid illegibly tiny text),
  // relying on the browser's own print pagination to flow rows across
  // however many physical pages they happened to need. That flow-based
  // approach is what actually caused the "skips first page" bug: the
  // .grid-box wrapper around the table (styles.css) carries a shared
  // break-inside: avoid rule (written for Setup/Cleanup's much shorter
  // card grids), and a roster tall enough to never fit on a single
  // remaining page gets pushed onto page 2 in one piece, leaving page 1
  // holding only the print header.
  //
  // Splitting rows into fixed 50-row chunks (.roster-print-chunk in the
  // view, styles.css's own comment on that class has the rest of the
  // story) directly fixes that: .grid-box's break-inside: avoid is
  // overridden back to auto inside a chunk, so a chunk that's too tall
  // for the page it starts on simply lets its own table split across a
  // physical page boundary (header row repeating) instead of jumping
  // wholesale to the next page. Each chunk still forces a page break
  // BEFORE the next one, so chunk boundaries always land on a fresh
  // sheet. Deliberately NOT wrapped in a shrink-to-fit box (verified live
  // via Playwright + pdfjs text extraction, per physical page, that the
  // shrink-to-fit + fixed-height + overflow:hidden combination used
  // elsewhere on this page silently drops rows once a chunk's real
  // content still doesn't fit even at print-shrink-to-fit.js's own
  // legibility floor) - a 50-row chunk landing on more than one physical
  // page for an unusually wide/dense roster is an honest, lossless
  // outcome; silently missing attendance rows on a printed record is not.
  const ROWS_PER_PRINT_PAGE = 50;
  const gridPages = [];
  for (let i = 0; i < grid.rows.length || i === 0; i += ROWS_PER_PRINT_PAGE) {
    gridPages.push({ dateLabels: grid.dateLabels, rows: grid.rows.slice(i, i + ROWS_PER_PRINT_PAGE), summary: grid.summary });
    if (grid.rows.length === 0) break;
  }

  res.render('admin-rosters-print', {
    title: `${tabLabel} Print Preview`,
    view: 'grid',
    tabLabel,
    dayLabel: CLASS_DAY_LABELS_FULL[day],
    gridPages,
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
  const info = tabInfo(tab);
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
  const info = tabInfo(tab);
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
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${dates.length} date(s).`), comboSemesterId(req)));
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
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)} and its attendance records.`), comboSemesterId(req)));
});

// --- Roster membership ---

router.post('/rosters/:tab/add-member', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  for (const memberId of memberIds) await addManualRosterMember(rosterId, memberId);
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`Added ${memberIds.length} member(s).`), comboSemesterId(req)));
});

router.post('/rosters/:tab/remove-member/:memberId', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const rosterId = await rosterIdForTab(tab);
  if (!rosterId) return res.status(404).send('Not found');
  const memberId = parseInt(req.params.memberId, 10);
  await db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, memberId);
  // A real bug report: "if someone is manually deleted from the roster
  // they are not automatically added back unless their schedule
  // changes." Remembers this was a deliberate removal so utils/
  // classSchedule.js's setRosterMembership skips re-adding them on the
  // next routine resync - cleared only when their own schedule actually
  // changes (setEnrollment/addStaff) or they're manually re-added
  // (addManualRosterMember).
  await db
    .prepare('INSERT INTO roster_manual_removals (roster_id, member_id) VALUES (?, ?) ON CONFLICT (roster_id, member_id) DO UPDATE SET removed_at = now_text()')
    .run(rosterId, memberId);
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}`, comboSemesterId(req)));
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
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent('Attendance saved.'), comboSemesterId(req)));
});

// Re-runs syncDayMemberRosters(day) on demand instead of only reactively
// on the next enrollment/staffing/floater edit - this is normally
// automatic (see that function's own comment), but a family whose
// roster/floater membership went stale under old logic before a fix
// landed has no reason to get touched again on its own, so this gives an
// admin a way to force it without making a throwaway edit. Auto-added
// ('source'='auto') roster members not in the freshly computed set are
// removed; anyone added by hand via + Add Member is untouched either way.
router.post('/rosters/:day/resync', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  await syncDayMemberRosters(day);
  const tab = req.body.tab && tabInfo(req.body.tab) && tabInfo(req.body.tab).day === day ? req.body.tab : `${day}-student`;
  res.redirect(appendSemester(`/admin/rosters?tab=${tab}&notice=` + encodeURIComponent(`${CLASS_DAY_LABELS_FULL[day]} rosters resynced.`), comboSemesterId(req)));
});

router.get('/roster/:tab/export.csv', requireAdmin, async (req, res) => {
  const tab = req.params.tab;
  const classId = classIdFromTab(tab);
  const label = classId ? ((await classRosterInfo(classId)) || {}).class_name : (tabInfo(tab) || {}).label;
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
