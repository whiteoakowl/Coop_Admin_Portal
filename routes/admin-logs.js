const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatDateLabel, formatTime, formatTimestamp } = require('../utils/dates');
const { REASON_LABELS } = require('../utils/rosters');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');

const LOG_TABS = ['absence', 'checkinout', 'nametag', 'messages', 'membership'];

// Every Absence/Late form submission across all rosters, newest first.
function allAbsenceSubmissions(dateFilter) {
  let sql = `SELECT m.name AS memberName, r.name AS rosterName, a.session_date AS date, a.status,
             a.reason_category AS reasonCategory, a.reason_text AS reasonText
             FROM attendance a
             JOIN members m ON m.id = a.member_id
             JOIN rosters r ON r.id = a.roster_id
             WHERE a.source = 'absence_form'`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.session_date DESC, m.name COLLATE NOCASE';

  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'late' ? 'Late' : 'Absent',
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
}

function absenceSubmissionDates() {
  return db
    .prepare(`SELECT DISTINCT session_date FROM attendance WHERE source = 'absence_form' ORDER BY session_date DESC`)
    .all()
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

function checkinoutLogRows(dateFilter) {
  let sql = `SELECT m.name AS memberName, r.name AS rosterName, a.session_date AS date,
             a.check_in_time AS checkInTime, c.check_out_time AS checkOutTime, c.number AS number
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

function checkinoutLogDates() {
  return db
    .prepare(`SELECT DISTINCT session_date FROM attendance WHERE check_in_time IS NOT NULL ORDER BY session_date DESC`)
    .all()
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
}

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const NAME_TAG_DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

function nameTagSubmissions(showArchived, dateFilter) {
  let sql = `SELECT n.id AS id, m.name AS memberName, n.request_type AS requestType, n.day AS day,
             n.description AS description, n.created_at AS createdAt
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

function membershipRequests(showArchived, dateFilter) {
  let sql = `SELECT * FROM membership_requests WHERE archived = ?`;
  const params = [showArchived ? 1 : 0];
  if (dateFilter) {
    sql += ' AND date(created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY created_at DESC';
  const requests = db.prepare(sql).all(...params);
  const childrenStmt = db.prepare('SELECT * FROM membership_request_children WHERE request_id = ? ORDER BY id');
  return requests.map((r) => ({ ...r, children: childrenStmt.all(r.id) }));
}

function contactAdminMessages(showArchived, dateFilter) {
  let sql = `SELECT * FROM contact_admin_messages WHERE archived = ?`;
  const params = [showArchived ? 1 : 0];
  if (dateFilter) {
    sql += ' AND date(created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

router.get('/logs', requireAdmin, (req, res) => {
  const tab = LOG_TABS.includes(req.query.tab) ? req.query.tab : 'absence';
  const dateFilter = req.query.date || '';

  if (tab === 'membership') {
    const showArchived = req.query.archived === '1';
    const requests = membershipRequests(showArchived, dateFilter).map((r) => ({
      ...r,
      timestamp: formatTimestamp(r.created_at),
    }));
    const dates = db
      .prepare(`SELECT DISTINCT date(created_at) AS d FROM membership_requests WHERE archived = ? ORDER BY d DESC`)
      .all(showArchived ? 1 : 0)
      .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
    return res.render('admin-logs', {
      title: 'Membership Requests',
      tab,
      requests,
      dates,
      dateFilter,
      showArchived,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'messages') {
    const showArchived = req.query.archived === '1';
    const messages = contactAdminMessages(showArchived, dateFilter).map((m) => ({
      id: m.id,
      timestamp: formatTimestamp(m.created_at),
      leadershipTeam: m.leadership_team,
      senderEmail: m.sender_email,
      title: m.title,
      message: m.message,
    }));
    const dates = db
      .prepare(`SELECT DISTINCT date(created_at) AS d FROM contact_admin_messages WHERE archived = ? ORDER BY d DESC`)
      .all(showArchived ? 1 : 0)
      .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
    return res.render('admin-logs', {
      title: 'Contact Admins Messages',
      tab,
      messages,
      dates,
      dateFilter,
      showArchived,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'checkinout') {
    const rows = checkinoutLogRows(dateFilter).map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      checkInTime: formatTime(r.checkInTime) || '—',
      checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : '—',
      number: r.number ?? '—',
    }));
    return res.render('admin-logs', {
      title: 'Check In/Out Log',
      tab,
      rows,
      dates: checkinoutLogDates(),
      dateFilter,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (tab === 'nametag') {
    const showArchived = req.query.archived === '1';
    const submissions = nameTagSubmissions(showArchived, dateFilter).map((r) => ({
      id: r.id,
      timestamp: formatTimestamp(r.createdAt),
      memberName: r.memberName,
      requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
      dayLabel: NAME_TAG_DAY_LABELS[r.day] || r.day,
      description: r.description || '—',
    }));
    const dates = db
      .prepare(`SELECT DISTINCT date(created_at) AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`)
      .all(showArchived ? 1 : 0)
      .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
    return res.render('admin-logs', {
      title: 'Name Tag Requests',
      tab,
      submissions,
      dates,
      dateFilter,
      showArchived,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  res.render('admin-logs', {
    title: 'Absence/Late Log',
    tab,
    submissions: allAbsenceSubmissions(dateFilter),
    dates: absenceSubmissionDates(),
    dateFilter,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/logs/absence/export.csv', requireAdmin, (req, res) => {
  const dateFilter = req.query.date || '';
  const submissions = allAbsenceSubmissions(dateFilter);
  const lines = [
    toCsvRow(['Name', 'Roster', 'Date', 'Status', 'Reason', 'Description']),
    ...submissions.map((s) => toCsvRow([s.memberName, s.rosterName, s.dateLabel, s.statusLabel, s.reasonLabel, s.description || ''])),
  ];
  sendCsv(res, 'absence-late-log.csv', lines);
});

router.get('/logs/checkinout/export.csv', requireAdmin, (req, res) => {
  const dateFilter = req.query.date || '';
  const rows = checkinoutLogRows(dateFilter);
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

router.get('/logs/nametag/export.csv', requireAdmin, (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = nameTagSubmissions(showArchived, dateFilter);
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

router.post('/logs/nametag/:id/archive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(id);
  res.redirect('/admin/logs?tab=nametag');
});

router.post('/logs/nametag/:id/unarchive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(id);
  res.redirect('/admin/logs?tab=nametag&archived=1');
});

router.get('/logs/messages/export.csv', requireAdmin, (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const messages = contactAdminMessages(showArchived, dateFilter);
  const lines = [
    toCsvRow(['Submitted', 'Leadership Team', 'From', 'Title', 'Message']),
    ...messages.map((m) => toCsvRow([formatTimestamp(m.created_at), m.leadership_team, m.sender_email, m.title, m.message])),
  ];
  sendCsv(res, `contact-admins-${showArchived ? 'archived' : 'messages'}.csv`, lines);
});

router.post('/logs/messages/:id/archive', requireAdmin, (req, res) => {
  db.prepare('UPDATE contact_admin_messages SET archived = 1 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/admin/logs?tab=messages');
});

router.post('/logs/messages/:id/unarchive', requireAdmin, (req, res) => {
  db.prepare('UPDATE contact_admin_messages SET archived = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/admin/logs?tab=messages&archived=1');
});

router.post('/logs/membership/:id/archive', requireAdmin, (req, res) => {
  db.prepare('UPDATE membership_requests SET archived = 1 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/admin/logs?tab=membership');
});

router.post('/logs/membership/:id/unarchive', requireAdmin, (req, res) => {
  db.prepare('UPDATE membership_requests SET archived = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/admin/logs?tab=membership&archived=1');
});

// Old standalone URLs now live under the unified Logs tab.
router.get('/absence-list', requireAdmin, (req, res) => {
  res.redirect('/admin/logs?tab=absence' + (req.query.date ? '&date=' + encodeURIComponent(req.query.date) : ''));
});
router.get('/checkinout-log', requireAdmin, (req, res) => {
  res.redirect('/admin/logs?tab=checkinout' + (req.query.date ? '&date=' + encodeURIComponent(req.query.date) : ''));
});

module.exports = router;
