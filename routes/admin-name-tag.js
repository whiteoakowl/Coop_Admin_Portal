const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatTimestamp, formatDateLabel } = require('../utils/dates');

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

router.get('/name-tag', requireAdmin, (req, res) => {
  const dateFilter = req.query.date || '';

  let sql = `SELECT m.name AS memberName, n.request_type AS requestType, n.day AS day,
             n.description AS description, n.created_at AS createdAt
             FROM name_tag_requests n
             JOIN members m ON m.id = n.member_id`;
  const params = [];
  if (dateFilter) {
    sql += ' WHERE date(n.created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY n.created_at DESC';

  const submissions = db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      timestamp: formatTimestamp(r.createdAt),
      memberName: r.memberName,
      requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
      dayLabel: DAY_LABELS[r.day] || r.day,
      description: r.description || '—',
    }));

  const dates = db
    .prepare(`SELECT DISTINCT date(created_at) AS d FROM name_tag_requests ORDER BY d DESC`)
    .all()
    .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));

  res.render('admin-name-tag', { title: 'Name Tag Requests', submissions, dates, dateFilter });
});

module.exports = router;
