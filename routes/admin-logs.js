const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatDateLabel, formatTime, formatDateAndTime, formatNumericDateAndTime, todayISO, weekdayOf } = require('../utils/dates');
const { REASON_LABELS } = require('../utils/rosters');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { classesAtRiskForDay, CLASS_DAY_LABELS_FULL, listActiveClassDays, ensureDayMemberRosters } = require('../utils/classSchedule');
const { isValidClassDay, CLASS_DAY_WEEKDAY_FULL } = require('../utils/classDays');
const { substituteBoard } = require('../utils/substitutes');
const { membersWithMedicalNotes, lastNameOf } = require('../utils/members');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { scannedTasksForMemberDate } = require('../utils/setup');

const LOG_TABS = ['absence', 'checkinout', 'classcheckinout', 'nametag', 'classrisk', 'substitutes', 'allergies', 'classregistration', 'missedduty'];

function todayIfSessionDay(day) {
  const today = todayISO();
  return weekdayOf(today) === CLASS_DAY_WEEKDAY_FULL[day] ? today : null;
}

// Every Absence/Late form submission, newest first - one row per actual
// submission event, not per roster. Reads from absence_submissions - a
// separate, append-only record of each submission (see that migration's
// own comment) - rather than the live attendance row a submission first
// writes, because a member who later checks in for real overwrites that
// row's status/source straight to 'present'/'kiosk' (a real, intended
// behavior - see routes/kiosk.js) which used to make the submission
// vanish from this log too.
//
// A real bug report: "absence log should only show the original
// submission of absence from the absence form. it doesn't need to show
// absence log from classes. absences from the absence form do still
// appear on each class roster." routes/absence.js writes one
// absence_submissions row per roster the member belongs to that day
// (getMemberRostersForDate returns the day-level Parent/Student roster
// AND every one of that member's own class rosters), so a student
// enrolled in 3 classes produced 4 near-identical rows here - the same
// submission listed 4 times, once per roster. The class rosters
// themselves still show the absence exactly as before (nothing about
// that changes) - this only trims the standalone admin Log tab back down
// to the one row that's the actual submission event, by reading just the
// day-level roster's own copy (category != 'Class Roster', the same
// distinction checkinoutCategoryClause already draws between a day-level
// and a per-class roster) instead of every roster's copy.
async function allAbsenceSubmissions(dateFilter) {
  let sql = `SELECT m.name AS "memberName", m.family_id AS "familyId", f.name AS "familyName",
             r.name AS "rosterName", a.session_date AS date, a.status,
             a.reason_category AS "reasonCategory", a.reason_text AS "reasonText", a.submitted_at AS "submittedAt"
             FROM absence_submissions a
             JOIN members m ON m.id = a.member_id
             LEFT JOIN families f ON f.id = m.family_id
             JOIN rosters r ON r.id = a.roster_id
             WHERE r.category != 'Class Roster'`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.session_date DESC';

  return (await db
    .prepare(sql)
    .all(...params))
    .map((r) => {
      // A real request: "Absence/late log, include the date and time the
      // member submitted the form on the log. Use 12/12/2026 and 12:45pm
      // as the format." submitted_at already existed on this table
      // (absence_submissions' own migration) - the form's real submit
      // time, distinct from `date`/dateLabel above (the CLASS session
      // date the absence is FOR, which the parent can backdate/forward-
      // date independently of when they actually filled out the form).
      const { dateLabel: submittedDateLabel, timeLabel: submittedTimeLabel } = formatNumericDateAndTime(r.submittedAt);
      return {
        memberName: r.memberName,
        familyId: r.familyId,
        familyName: r.familyName,
        rosterName: r.rosterName,
        date: r.date,
        dateLabel: formatDateLabel(r.date),
        statusLabel: r.status === 'late' ? 'Late' : 'Absent',
        reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
        description: r.reasonText || '—',
        submittedDateLabel,
        submittedTimeLabel,
      };
    })
    // Date desc stays the primary sort (newest submissions first) - last
    // name only breaks ties within the same date, same as everywhere else
    // member names sort ("ABC order according to the last name").
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) ||
        a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' })
    );
}

// A real request, with a reference design: "only show family name and
// dropdown to show all members in that family marked absent... new
// family entry for every day a family submits for absence." Groups the
// flat per-member submissions above by (family, date) - a family with
// members absent/late on two different days gets two separate group
// entries, one per day, each expanding to just that day's own members
// (not the family's whole history). A member with no family becomes
// their own solo group, keyed off their own id rather than a shared
// null family_id (which would otherwise incorrectly lump every familyless
// member's submissions together).
function groupAbsenceSubmissionsByFamilyAndDate(submissions) {
  const groups = new Map();
  for (const s of submissions) {
    const key = `${s.familyId != null ? `f${s.familyId}` : `solo-${s.memberName}`}|${s.date}`;
    if (!groups.has(key)) {
      groups.set(key, { key, familyName: s.familyName || s.memberName, date: s.date, dateLabel: s.dateLabel, members: [] });
    }
    groups.get(key).members.push(s);
  }
  // Insertion order already follows allAbsenceSubmissions' own date-desc/
  // last-name sort, so the first member seen in each group also fixes
  // that group's own overall sort position - no separate re-sort needed.
  return Array.from(groups.values());
}

async function absenceSubmissionDates() {
  return (await db
    .prepare(`SELECT DISTINCT session_date FROM absence_submissions ORDER BY session_date DESC`)
    .all())
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

// A real request: "Under logs tab add a class registration tab organized
// chart by day and family, families grouped together under a particular
// date." One row per class_registrations entry (the audit trail of every
// register/waitlist/cancel action - not class_enrollments, which only
// ever reflects CURRENT enrollment and would silently drop a since-
// cancelled registration from the log). `date` is the calendar day the
// registration action happened (created_at's own date half), the same
// "group by family, then by day" shape groupAbsenceSubmissionsByFamilyAndDate
// already builds for the Absence Log - reused as-is below rather than
// duplicating it, since the grouping key (familyId/familyName/memberName/
// date/dateLabel) lines up exactly.
async function allClassRegistrations(dateFilter) {
  let sql = `SELECT m.name AS "memberName", m.family_id AS "familyId", f.name AS "familyName",
             c.class_name AS "className", c.day AS "classDay",
             cr.status AS status, cr.created_at AS "createdAt"
             FROM class_registrations cr
             JOIN members m ON m.id = cr.student_id
             LEFT JOIN families f ON f.id = m.family_id
             JOIN classes c ON c.id = cr.class_id`;
  const params = [];
  if (dateFilter) {
    sql += ` WHERE substr(cr.created_at, 1, 10) = ?`;
    params.push(dateFilter);
  }
  sql += ' ORDER BY cr.created_at DESC';

  return (await db
    .prepare(sql)
    .all(...params))
    .map((r) => ({
      memberName: r.memberName,
      familyId: r.familyId,
      familyName: r.familyName,
      className: r.className,
      classDayLabel: CLASS_DAY_LABELS_FULL[r.classDay] || r.classDay,
      date: r.createdAt.slice(0, 10),
      dateLabel: formatDateLabel(r.createdAt.slice(0, 10)),
      statusLabel: r.status === 'waitlisted' ? 'Waitlisted' : r.status === 'cancelled' ? 'Cancelled' : 'Confirmed',
    }))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) ||
        a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' })
    );
}

async function classRegistrationDates() {
  return (await db
    .prepare(`SELECT DISTINCT substr(created_at, 1, 10) AS date FROM class_registrations ORDER BY date DESC`)
    .all())
    .map((r) => ({ date: r.date, label: formatDateLabel(r.date) }));
}

// A real bug report: "There should be a seperate log for Class Check
// in/out and co-op check in/out." Both check-in kinds write onto the
// same attendance/checkouts rows (routes/kiosk.js for the front-door
// Parent/Student roster, routes/kiosk-class-checkin.js for a single
// class's own roster) - the only thing distinguishing them afterward is
// which roster the row belongs to: a class's own roster is always
// category='Class Roster' (utils/classSchedule.js's ensureClassRoster),
// while the day-level Parent/Student rosters check-in itself uses are
// category='Class Schedule' (ensureDayRoster) - anything NOT 'Class
// Roster'. kind is 'class' or 'coop', never user input.
function checkinoutCategoryClause(kind) {
  return kind === 'class' ? "r.category = 'Class Roster'" : "r.category != 'Class Roster'";
}

async function checkinoutLogRows(dateFilter, kind) {
  let sql = `SELECT m.name AS "memberName", r.name AS "rosterName", a.session_date AS date,
             a.check_in_time AS "checkInTime", c.check_out_time AS "checkOutTime", c.number AS number
             FROM attendance a
             JOIN members m ON m.id = a.member_id
             JOIN rosters r ON r.id = a.roster_id
             LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
             WHERE a.check_in_time IS NOT NULL AND ${checkinoutCategoryClause(kind)}`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.check_in_time DESC';

  return db.prepare(sql).all(...params);
}

async function checkinoutLogDates(kind) {
  return (await db
    .prepare(
      `SELECT DISTINCT a.session_date FROM attendance a
       JOIN rosters r ON r.id = a.roster_id
       WHERE a.check_in_time IS NOT NULL AND ${checkinoutCategoryClause(kind)}
       ORDER BY a.session_date DESC`
    )
    .all())
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

const REQUEST_TYPE_LABELS = { new_tag: 'New Name Tag', lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const NAME_TAG_DAY_LABELS = { ...CLASS_DAY_LABELS_FULL, both: 'Both' };

async function nameTagSubmissions(showArchived, dateFilter) {
  let sql = `SELECT n.id AS id, m.name AS "memberName", n.request_type AS "requestType", n.day AS day,
             n.description AS description, n.created_at AS "createdAt"
             FROM name_tag_requests n
             JOIN members m ON m.id = n.member_id
             WHERE n.archived = ?`;
  const params = [showArchived ? 1 : 0];
  if (dateFilter) {
    sql += ' AND date(n.created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY n.created_at DESC';

  return db.prepare(sql).all(...params);
}

// A real request: "Create a co-op admin log for each day of scheduled
// classes that makes a list of the parent members who don't scan a
// setup/cleanup badge and parent[s] who don't check in or submit an
// absence form and are a no show completel[y] ... organized by the date
// and next to each member it will show how many times they have missed
// scanning the setup/cleanup badge and how many times they didn't
// checkin or submit an absence for[m] for the day." Two independent
// "was this parent accountable today" checks, merged into one row per
// (date, member) when a parent trips both on the same day:
//
//   - Missed Setup/Cleanup: setup_task_assignments has a real suggestion
//     for this member/date (any of the 3 slots - utils/setup.js's own
//     taskAssignmentsForDate uses the identical "any slot" test), but
//     scannedTasksForMemberDate (the same real-badge-scan-only signal
//     the live Assignments page's own "Task(s) complete" badge uses - see
//     that function's own comment) never saw an actual scan from them
//     that date. Being assigned never implies completion - that's the
//     whole reason scannedTasksForMemberDate exists in the first place.
//   - No-Show: a parent member of that day's own Parent roster
//     (roster_members - whole-term membership, independent of which
//     dates that roster actually met) with neither a real check-in
//     (attendance.check_in_time) NOR an absence_submissions row for that
//     roster/date - they simply never showed up and never said why.
//
// Both only ever look at dates strictly before today - the day isn't
// over yet, so a parent who hasn't shown up (or scanned) YET this
// afternoon isn't a no-show/miss until the day actually ends.
async function missedSetupCleanupRows() {
  const assignmentRows = await db
    .prepare(
      `SELECT sta.member_id AS "memberId", sta.session_date AS date, m.name AS "memberName",
              m.family_id AS "familyId", f.name AS "familyName"
       FROM setup_task_assignments sta
       JOIN members m ON m.id = sta.member_id
       LEFT JOIN families f ON f.id = m.family_id
       WHERE (sta.task_item_id IS NOT NULL OR sta.task_item_id_2 IS NOT NULL OR sta.task_item_id_3 IS NOT NULL)
         AND sta.session_date < ?
       ORDER BY sta.session_date ASC`
    )
    .all(todayISO());

  // Grouped by date so scannedTasksForMemberDate (one query per date) only
  // runs once per distinct date, not once per assignment row.
  const byDate = new Map();
  for (const r of assignmentRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  const missed = [];
  for (const [date, rows] of byDate) {
    const scanned = await scannedTasksForMemberDate(date);
    for (const r of rows) {
      if (!scanned[r.memberId]) missed.push(r);
    }
  }
  return missed;
}

async function noShowRows() {
  const dayRosterIds = await ensureDayMemberRosters();
  const parentRosterIds = Object.values(dayRosterIds).map((d) => d.parent);
  if (parentRosterIds.length === 0) return [];
  const placeholders = parentRosterIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT rd.session_date AS date, rm.member_id AS "memberId", m.name AS "memberName",
              m.family_id AS "familyId", f.name AS "familyName"
       FROM roster_dates rd
       JOIN roster_members rm ON rm.roster_id = rd.roster_id
       JOIN members m ON m.id = rm.member_id AND m.member_type = 'parent'
       LEFT JOIN families f ON f.id = m.family_id
       WHERE rd.roster_id IN (${placeholders})
         AND rd.session_date < ?
         AND NOT EXISTS (
           SELECT 1 FROM attendance a
           WHERE a.member_id = rm.member_id AND a.roster_id = rd.roster_id
             AND a.session_date = rd.session_date AND a.check_in_time IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM absence_submissions s
           WHERE s.member_id = rm.member_id AND s.roster_id = rd.roster_id AND s.session_date = rd.session_date
         )
       ORDER BY rd.session_date ASC`
    )
    .all(...parentRosterIds, todayISO());
}

// Merges the two miss lists above into one row per (date, member),
// stamping each row with BOTH counters' running totals as of that date -
// both numbers show on every row that member appears on, not just
// whichever counter that specific date's own flag was for, so an admin
// scanning down the dated log sees the full pattern building for a
// repeat offender either way. Chronological (date-ascending) processing
// is what makes "running total as of this date" meaningful; the two
// source lists are already date-ascending on their own, but need a true
// merge (not simply concatenated) so a member flagged for both reasons
// on the SAME date still lands on exactly one row with both counts
// correct, not two half-populated rows.
async function missedDutyRows() {
  const [missedScans, noShows] = await Promise.all([missedSetupCleanupRows(), noShowRows()]);
  const events = [...missedScans.map((r) => ({ ...r, kind: 'scan' })), ...noShows.map((r) => ({ ...r, kind: 'noshow' }))].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const scanCounts = new Map();
  const noShowCounts = new Map();
  const rowsByKey = new Map();
  const orderedKeys = [];

  for (const e of events) {
    const key = `${e.date}|${e.memberId}`;
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        date: e.date,
        dateLabel: formatDateLabel(e.date),
        memberId: e.memberId,
        memberName: e.memberName,
        familyId: e.familyId,
        familyName: e.familyName,
        missedScan: false,
        noShow: false,
      });
      orderedKeys.push(key);
    }
    const row = rowsByKey.get(key);
    if (e.kind === 'scan') {
      scanCounts.set(e.memberId, (scanCounts.get(e.memberId) || 0) + 1);
      row.missedScan = true;
    } else {
      noShowCounts.set(e.memberId, (noShowCounts.get(e.memberId) || 0) + 1);
      row.noShow = true;
    }
    row.scanCount = scanCounts.get(e.memberId) || 0;
    row.noShowCount = noShowCounts.get(e.memberId) || 0;
  }

  // Newest-first for display, same convention every other tab on this
  // page uses (allAbsenceSubmissions and friends) - AFTER the running
  // totals above were computed in true chronological (ascending) order,
  // which is the only order that makes "running total" mean anything.
  return orderedKeys
    .map((k) => rowsByKey.get(k))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) ||
        a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' })
    );
}

function groupMissedDutyRowsByDate(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.date)) groups.set(r.date, { date: r.date, dateLabel: r.dateLabel, members: [] });
    groups.get(r.date).members.push(r);
  }
  return Array.from(groups.values());
}

// A real request: "Class cancelation log should be a log by date[,] on
// each class row that is a class cancelation risk it shows a tally
// number of how many times this class has been at risk for
// cancelation[.] Add a filter button for choosing date or class."
// classesAtRiskForDay (utils/classSchedule.js) is a pure, on-demand
// computation - there has never been a table recording past risk flags,
// and no way to reconstruct a class's actual historical enrollment
// (class_enrollments has no date dimension at all - see that table's own
// migration). Rather than start a new table that could only ever log
// going forward (an empty log today, no past dates ever possible),
// this REPLAYS the real question - "would this class have shown as at
// risk on date X?" - for every date that could possibly have flagged
// one: classesAtRiskForDay can only ever return something for a date
// with at least one qualifying absence form submission, so every other
// date is skipped outright rather than run through the full computation
// for nothing. The one honest approximation this makes: it checks each
// PAST date's real absence-form history (absence_submissions genuinely
// is per-date, append-only) against TODAY's current class roster, not
// that day's actual roster - the same tradeoff classesAtRiskForDay
// already makes for any date handed to it directly, not something new
// this log introduces.
async function classCancellationRiskRows() {
  // Real, append-only absence-form history (member_id + the date it was
  // FOR), grouped by date up front in one query - the signal
  // classesAtRiskForDay's own default lookup can't give a past date a
  // reliable answer on, since it reads the live, overwritable
  // `attendance` row instead (see that function's own absentIdsOverride
  // comment for the full story on why).
  const submissionRows = await db
    .prepare(`SELECT session_date, member_id FROM absence_submissions WHERE status = 'absent'`)
    .all();
  if (submissionRows.length === 0) return [];
  const absentIdsByDate = new Map();
  for (const r of submissionRows) {
    if (!absentIdsByDate.has(r.session_date)) absentIdsByDate.set(r.session_date, new Set());
    absentIdsByDate.get(r.session_date).add(r.member_id);
  }
  const submissionDates = Array.from(absentIdsByDate.keys()).sort();

  const activeDays = new Set(await listActiveClassDays());
  const dayNameForWeekday = {};
  Object.entries(CLASS_DAY_WEEKDAY_FULL).forEach(([name, num]) => {
    dayNameForWeekday[num] = name;
  });

  const rows = [];
  for (const date of submissionDates) {
    const dayName = dayNameForWeekday[weekdayOf(date)];
    if (!dayName || !activeDays.has(dayName)) continue;
    const atRisk = await classesAtRiskForDay(dayName, date, absentIdsByDate.get(date));
    for (const c of atRisk) {
      rows.push({
        date,
        dateLabel: formatDateLabel(date),
        classId: c.classId,
        className: c.className,
        hourLabel: c.hourLabel,
        room: c.room,
        enrolledCount: c.enrolledCount,
        expectedCount: c.expectedCount,
      });
    }
  }

  // Running tally per class, computed in true chronological order (the
  // loop above already walked submissionDates ascending) - same "stamp
  // the running total onto every row, right when it's processed" shape
  // routes/admin-logs.js's own missedDutyRows already established.
  const tallies = new Map();
  for (const r of rows) {
    const tally = (tallies.get(r.classId) || 0) + 1;
    tallies.set(r.classId, tally);
    r.riskTally = tally;
  }

  // Newest-first for display, same convention every other tab on this
  // page uses - after the running tally above was computed in true
  // ascending order, which is the only order "running total" means
  // anything in.
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.className.localeCompare(b.className, undefined, { sensitivity: 'base' }));
}

function groupClassRiskRowsByDate(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.date)) groups.set(r.date, { date: r.date, dateLabel: r.dateLabel, classes: [] });
    groups.get(r.date).classes.push(r);
  }
  return Array.from(groups.values());
}

router.get('/logs', requireAdmin, async (req, res) => {
  const tab = LOG_TABS.includes(req.query.tab) ? req.query.tab : 'absence';
  const dateFilter = req.query.date || '';

  if (tab === 'checkinout' || tab === 'classcheckinout') {
    const kind = tab === 'classcheckinout' ? 'class' : 'coop';
    const allRows = (await checkinoutLogRows(dateFilter, kind)).map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      checkInTime: formatTime(r.checkInTime) || '—',
      checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : '—',
      number: r.number ?? '—',
    }));
    const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const pagination = paginate(allRows, parsePage(req.query.page), pageSize);
    return res.render('admin-logs', {
      title: kind === 'class' ? 'Class Check-In/Out Log' : 'Co-op Check-In/Out Log',
      tab,
      rows: pagination.items,
      allRows,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=${tab}${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
      dates: await checkinoutLogDates(kind),
      dateFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'nametag') {
    const showArchived = req.query.archived === '1';
    const allSubmissions = (await nameTagSubmissions(showArchived, dateFilter)).map((r) => ({
      id: r.id,
      ...formatDateAndTime(r.createdAt),
      memberName: r.memberName,
      requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
      dayLabel: NAME_TAG_DAY_LABELS[r.day] || r.day,
      description: r.description || '—',
    }));
    const dates = (await db
      .prepare(`SELECT DISTINCT date(created_at)::text AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`)
      .all(showArchived ? 1 : 0))
      .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
    const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const pagination = paginate(allSubmissions, parsePage(req.query.page), pageSize);
    return res.render('admin-logs', {
      title: 'Name Tag Requests',
      tab,
      submissions: pagination.items,
      allSubmissions,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=nametag${showArchived ? '&archived=1' : ''}${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
      dates,
      dateFilter,
      showArchived,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'classrisk') {
    // "Add a filter button for choosing date or class" - two mutually
    // exclusive filter modes on the same log, not two separate filters
    // both active at once (filtering to one specific date AND one
    // specific class at the same time would almost always show nothing,
    // since a class is rarely at risk on more than a handful of dates).
    const filterBy = req.query.filterBy === 'class' ? 'class' : 'date';
    const classIdFilter = req.query.classId ? parseInt(req.query.classId, 10) : null;
    const riskDateFilter = filterBy === 'date' ? req.query.date || '' : '';

    const allRows = await classCancellationRiskRows();
    // Already newest-first (classCancellationRiskRows' own sort) - a Map
    // keyed by date/classId preserves first-seen order, so both filter
    // dropdowns stay newest-first/already-sorted too without a separate
    // sort pass.
    const dates = Array.from(new Map(allRows.map((r) => [r.date, { date: r.date, label: r.dateLabel }])).values());
    const classOptions = Array.from(new Map(allRows.map((r) => [r.classId, { classId: r.classId, className: r.className }])).values()).sort(
      (a, b) => a.className.localeCompare(b.className, undefined, { sensitivity: 'base' })
    );

    const filteredRows =
      filterBy === 'class' && classIdFilter != null
        ? allRows.filter((r) => r.classId === classIdFilter)
        : riskDateFilter
          ? allRows.filter((r) => r.date === riskDateFilter)
          : allRows;
    const dateGroups = groupClassRiskRowsByDate(filteredRows);
    const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const pagination = paginate(dateGroups, parsePage(req.query.page), pageSize);
    const classNameFilter = classIdFilter != null ? (classOptions.find((c) => c.classId === classIdFilter) || {}).className : null;

    return res.render('admin-logs', {
      title: 'Class Cancellation Risk',
      tab,
      filterBy,
      dateGroups: pagination.items,
      allSubmissions: filteredRows,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=classrisk&filterBy=${filterBy}${riskDateFilter ? `&date=${encodeURIComponent(riskDateFilter)}` : ''}${classIdFilter != null ? `&classId=${classIdFilter}` : ''}&`,
      dates,
      classOptions,
      dateFilter: riskDateFilter,
      dateFilterLabel: riskDateFilter ? formatDateLabel(riskDateFilter) : 'All dates',
      classIdFilter,
      classNameFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'substitutes') {
    const activeDays = await listActiveClassDays();
    const day = isValidClassDay(req.query.day) ? req.query.day : (activeDays[0] || 'monday');
    const dateFilter = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayIfSessionDay(day) || '';
    // A real request: "the substitutes needed list under logs should only
    // show teacher and assistant positions that need a floater, not
    // permanent positions." substituteBoard's own slots mix both
    // slotType:'class' (a missing teacher/assistant) and slotType:'job'
    // (a permanent job, staffed every session regardless of absences) -
    // this list only wants the former. admin-volunteers.js's own
    // substituteBoard call (the Floater Assignments manage page) is left
    // untouched - it deliberately shows both (see its own comment on that
    // history), so the filter is scoped to just this route/tab.
    const fullBoard = await substituteBoard(day, dateFilter || null);
    const board = fullBoard.map((hour) => ({ ...hour, slots: hour.slots.filter((s) => s.slotType === 'class') }));
    return res.render('admin-logs', {
      title: 'Substitutes Needed',
      tab,
      day,
      activeDays,
      dayLabels: CLASS_DAY_LABELS_FULL,
      dayLabel: CLASS_DAY_LABELS_FULL[day],
      dateFilter,
      board,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'allergies') {
    return res.render('admin-logs', {
      title: 'Allergies/Medical Log',
      tab,
      medicalMembers: await membersWithMedicalNotes(),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'missedduty') {
    const allRows = await missedDutyRows();
    // allRows is already newest-first (missedDutyRows' own sort) - a Map
    // keyed by date preserves first-seen order, so this stays newest-
    // first too without a separate sort.
    const dates = Array.from(new Map(allRows.map((r) => [r.date, { date: r.date, label: r.dateLabel }])).values());
    const filteredRows = dateFilter ? allRows.filter((r) => r.date === dateFilter) : allRows;
    const dateGroups = groupMissedDutyRowsByDate(filteredRows);
    const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const pagination = paginate(dateGroups, parsePage(req.query.page), pageSize);
    return res.render('admin-logs', {
      title: 'Missed Duty / No-Show Log',
      tab,
      dateGroups: pagination.items,
      allSubmissions: filteredRows,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=missedduty${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
      dates,
      dateFilter,
      dateFilterLabel: dateFilter ? formatDateLabel(dateFilter) : 'All dates',
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'classregistration') {
    const allRegistrations = await allClassRegistrations(dateFilter);
    const allFamilyGroups = groupAbsenceSubmissionsByFamilyAndDate(allRegistrations);
    const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const pagination = paginate(allFamilyGroups, parsePage(req.query.page), pageSize);
    return res.render('admin-logs', {
      title: 'Class Registration Log',
      tab,
      familyGroups: pagination.items,
      allSubmissions: allRegistrations,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=classregistration${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
      dates: await classRegistrationDates(),
      dateFilter,
      dateFilterLabel: dateFilter ? formatDateLabel(dateFilter) : 'All dates',
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const allSubmissions = await allAbsenceSubmissions(dateFilter);
  const allFamilyGroups = groupAbsenceSubmissionsByFamilyAndDate(allSubmissions);
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allFamilyGroups, parsePage(req.query.page), pageSize);
  res.render('admin-logs', {
    title: 'Absence/Late Log',
    tab,
    familyGroups: pagination.items,
    allSubmissions,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: `/admin/logs?tab=absence${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
    dates: await absenceSubmissionDates(),
    dateFilter,
    dateFilterLabel: dateFilter ? formatDateLabel(dateFilter) : 'All dates',
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Allergies/Medical: shared by the Logs tab above and the popup
// button on roster/class view pages (fetched as a fragment, same pattern
// as the Class Schedule "View" popup). ---

router.get('/logs/allergies/fragment', requireAdmin, async (req, res) => {
  res.render('partials/allergy-log-popup-fragment', { medicalMembers: await membersWithMedicalNotes() });
});

router.get('/logs/allergies/export.csv', requireAdmin, async (req, res) => {
  const typeLabel = (t) => (t === 'parent' ? 'Parent' : 'Student');
  const lines = [
    toCsvRow(['Name', 'Type', 'Grade Level', 'Medical Notes']),
    ...(await membersWithMedicalNotes()).map((m) => toCsvRow([m.name, typeLabel(m.member_type), m.grade_level || '', m.medical_notes])),
  ];
  sendCsv(res, 'allergies-medical-log.csv', lines);
});

router.get('/logs/allergies/print', requireAdmin, async (req, res) => {
  res.render('logs-allergies-print', { title: 'Allergies/Medical Log', medicalMembers: await membersWithMedicalNotes() });
});

router.get('/logs/absence/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const submissions = await allAbsenceSubmissions(dateFilter);
  const lines = [
    toCsvRow(['Name', 'Roster', 'Date', 'Status', 'Reason', 'Description', 'Submitted Date', 'Submitted Time']),
    ...submissions.map((s) =>
      toCsvRow([s.memberName, s.rosterName, s.dateLabel, s.statusLabel, s.reasonLabel, s.description || '', s.submittedDateLabel || '', s.submittedTimeLabel || ''])
    ),
  ];
  sendCsv(res, 'absence-late-log.csv', lines);
});

router.get('/logs/classrisk/export.csv', requireAdmin, async (req, res) => {
  const filterBy = req.query.filterBy === 'class' ? 'class' : 'date';
  const classIdFilter = req.query.classId ? parseInt(req.query.classId, 10) : null;
  const dateFilter = filterBy === 'date' ? req.query.date || '' : '';
  const allRows = await classCancellationRiskRows();
  const rows =
    filterBy === 'class' && classIdFilter != null
      ? allRows.filter((r) => r.classId === classIdFilter)
      : dateFilter
        ? allRows.filter((r) => r.date === dateFilter)
        : allRows;
  const lines = [
    toCsvRow(['Date', 'Hour', 'Class', 'Room', 'Expected', 'Enrolled', 'Times At Risk (this class)']),
    ...rows.map((r) => toCsvRow([r.dateLabel, r.hourLabel, r.className, r.room || '', String(r.expectedCount), String(r.enrolledCount), String(r.riskTally)])),
  ];
  sendCsv(res, 'class-cancellation-risk-log.csv', lines);
});

router.get('/logs/missedduty/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const allRows = await missedDutyRows();
  const rows = dateFilter ? allRows.filter((r) => r.date === dateFilter) : allRows;
  const lines = [
    toCsvRow(['Date', 'Name', 'Family', 'Missed Setup/Cleanup This Date', 'No-Show This Date', 'Missed Setup/Cleanup Total', 'No-Show Total']),
    ...rows.map((r) =>
      toCsvRow([
        r.dateLabel,
        r.memberName,
        r.familyName || '',
        r.missedScan ? 'Yes' : '',
        r.noShow ? 'Yes' : '',
        String(r.scanCount),
        String(r.noShowCount),
      ])
    ),
  ];
  sendCsv(res, 'missed-duty-no-show-log.csv', lines);
});

router.get('/logs/classregistration/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const registrations = await allClassRegistrations(dateFilter);
  const lines = [
    toCsvRow(['Name', 'Class', 'Day', 'Date', 'Status']),
    ...registrations.map((r) => toCsvRow([r.memberName, r.className, r.classDayLabel, r.dateLabel, r.statusLabel])),
  ];
  sendCsv(res, 'class-registration-log.csv', lines);
});

router.get('/logs/checkinout/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const rows = await checkinoutLogRows(dateFilter, 'coop');
  const lines = [
    toCsvRow(['Name', 'Date', 'Check-In Time', 'Check-Out Time', 'Roster', 'Number']),
    ...rows.map((r) =>
      toCsvRow([
        r.memberName,
        formatDateLabel(r.date),
        formatTime(r.checkInTime) || '',
        r.checkOutTime ? formatTime(r.checkOutTime) : '',
        r.rosterName,
        r.number ?? '',
      ])
    ),
  ];
  sendCsv(res, 'co-op-check-in-out-log.csv', lines);
});

router.get('/logs/classcheckinout/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const rows = await checkinoutLogRows(dateFilter, 'class');
  const lines = [
    toCsvRow(['Name', 'Date', 'Check-In Time', 'Check-Out Time', 'Roster', 'Number']),
    ...rows.map((r) =>
      toCsvRow([
        r.memberName,
        formatDateLabel(r.date),
        formatTime(r.checkInTime) || '',
        r.checkOutTime ? formatTime(r.checkOutTime) : '',
        r.rosterName,
        r.number ?? '',
      ])
    ),
  ];
  sendCsv(res, 'class-check-in-out-log.csv', lines);
});

router.get('/logs/nametag/export.csv', requireAdmin, async (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = await nameTagSubmissions(showArchived, dateFilter);
  const lines = [
    toCsvRow(['Name', 'Description', 'Date', 'Time', 'Day', 'Request']),
    ...submissions.map((r) => {
      const { dateLabel, timeLabel } = formatDateAndTime(r.createdAt);
      return toCsvRow([
        r.memberName,
        r.description || '',
        dateLabel,
        timeLabel,
        NAME_TAG_DAY_LABELS[r.day] || r.day,
        REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
      ]);
    }),
  ];
  sendCsv(res, `name-tag-${showArchived ? 'archived' : 'requests'}.csv`, lines);
});

router.post('/logs/nametag/:id/archive', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(id);
  res.redirect('/admin/logs?tab=nametag');
});

router.post('/logs/nametag/:id/unarchive', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(id);
  res.redirect('/admin/logs?tab=nametag&archived=1');
});

// Old standalone URLs now live under the unified Logs tab.
router.get('/absence-list', requireAdmin, (req, res) => {
  res.redirect('/admin/logs?tab=absence' + (req.query.date ? '&date=' + encodeURIComponent(req.query.date) : ''));
});
router.get('/checkinout-log', requireAdmin, (req, res) => {
  res.redirect('/admin/logs?tab=checkinout' + (req.query.date ? '&date=' + encodeURIComponent(req.query.date) : ''));
});

module.exports = router;
