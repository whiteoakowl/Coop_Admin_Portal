const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatDateLabel, formatTime, formatTimestamp, todayISO, weekdayOf } = require('../utils/dates');
const { REASON_LABELS } = require('../utils/rosters');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { DAY_LABELS, isValidDay, defaultDay } = require('../utils/days');
const { classesAtRiskForDay } = require('../utils/classSchedule');
const { substituteBoard } = require('../utils/substitutes');
const { membersWithMedicalNotes, lastNameOf } = require('../utils/members');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

const LOG_TABS = ['absence', 'checkinout', 'nametag', 'classrisk', 'substitutes', 'allergies'];

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };
function todayIfSessionDay(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : null;
}

// Every Absence/Late form submission across all rosters, newest first.
async function allAbsenceSubmissions(dateFilter) {
  let sql = `SELECT m.name AS "memberName", r.name AS "rosterName", a.session_date AS date, a.status,
             a.reason_category AS "reasonCategory", a.reason_text AS "reasonText"
             FROM attendance a
             JOIN members m ON m.id = a.member_id
             JOIN rosters r ON r.id = a.roster_id
             WHERE a.source = 'absence_form'`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.session_date DESC';

  return (await db
    .prepare(sql)
    .all(...params))
    .map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      date: r.date,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'late' ? 'Late' : 'Absent',
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }))
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

async function absenceSubmissionDates() {
  return (await db
    .prepare(`SELECT DISTINCT session_date FROM attendance WHERE source = 'absence_form' ORDER BY session_date DESC`)
    .all())
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

async function checkinoutLogRows(dateFilter) {
  let sql = `SELECT m.name AS "memberName", r.name AS "rosterName", a.session_date AS date,
             a.check_in_time AS "checkInTime", c.check_out_time AS "checkOutTime", c.number AS number
             FROM attendance a
             JOIN members m ON m.id = a.member_id
             JOIN rosters r ON r.id = a.roster_id
             LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
             WHERE a.check_in_time IS NOT NULL`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.check_in_time DESC';

  return db.prepare(sql).all(...params);
}

async function checkinoutLogDates() {
  return (await db
    .prepare(`SELECT DISTINCT session_date FROM attendance WHERE check_in_time IS NOT NULL ORDER BY session_date DESC`)
    .all())
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

const REQUEST_TYPE_LABELS = { new_tag: 'New Name Tag', lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const NAME_TAG_DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

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

router.get('/logs', requireAdmin, async (req, res) => {
  const tab = LOG_TABS.includes(req.query.tab) ? req.query.tab : 'absence';
  const dateFilter = req.query.date || '';

  if (tab === 'checkinout') {
    const allRows = (await checkinoutLogRows(dateFilter)).map((r) => ({
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
      title: 'Check In/Out Log',
      tab,
      rows: pagination.items,
      allRows,
      pagination,
      viewingAll: pageSize === Infinity,
      baseHref: `/admin/logs?tab=checkinout${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
      dates: await checkinoutLogDates(),
      dateFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'nametag') {
    const showArchived = req.query.archived === '1';
    const allSubmissions = (await nameTagSubmissions(showArchived, dateFilter)).map((r) => ({
      id: r.id,
      timestamp: formatTimestamp(r.createdAt),
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
    const day = isValidDay(req.query.day) ? req.query.day : defaultDay();
    const alertDate = todayIfSessionDay(day);
    return res.render('admin-logs', {
      title: 'Class Cancellation Risk',
      tab,
      day,
      dayLabel: DAY_LABELS[day],
      alertDateLabel: alertDate ? formatDateLabel(alertDate) : null,
      classesAtRisk: await classesAtRiskForDay(day, alertDate),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'substitutes') {
    const day = isValidDay(req.query.day) ? req.query.day : defaultDay();
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
      dayLabel: DAY_LABELS[day],
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

  const allSubmissions = await allAbsenceSubmissions(dateFilter);
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allSubmissions, parsePage(req.query.page), pageSize);
  res.render('admin-logs', {
    title: 'Absence/Late Log',
    tab,
    submissions: pagination.items,
    allSubmissions,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: `/admin/logs?tab=absence${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
    dates: await absenceSubmissionDates(),
    dateFilter,
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
    toCsvRow(['Name', 'Roster', 'Date', 'Status', 'Reason', 'Description']),
    ...submissions.map((s) => toCsvRow([s.memberName, s.rosterName, s.dateLabel, s.statusLabel, s.reasonLabel, s.description || ''])),
  ];
  sendCsv(res, 'absence-late-log.csv', lines);
});

router.get('/logs/checkinout/export.csv', requireAdmin, async (req, res) => {
  const dateFilter = req.query.date || '';
  const rows = await checkinoutLogRows(dateFilter);
  const lines = [
    toCsvRow(['Name', 'Roster', 'Date', 'Check-In Time', 'Check-Out Time', 'Number']),
    ...rows.map((r) =>
      toCsvRow([
        r.memberName,
        r.rosterName,
        formatDateLabel(r.date),
        formatTime(r.checkInTime) || '',
        r.checkOutTime ? formatTime(r.checkOutTime) : '',
        r.number ?? '',
      ])
    ),
  ];
  sendCsv(res, 'check-in-out-log.csv', lines);
});

router.get('/logs/nametag/export.csv', requireAdmin, async (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = await nameTagSubmissions(showArchived, dateFilter);
  const lines = [
    toCsvRow(['Submitted', 'Name', 'Request', 'Day', 'Description']),
    ...submissions.map((r) =>
      toCsvRow([
        formatTimestamp(r.createdAt),
        r.memberName,
        REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
        NAME_TAG_DAY_LABELS[r.day] || r.day,
        r.description || '',
      ])
    ),
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
