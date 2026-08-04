const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatTimestamp } = require('../utils/dates');

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

router.get('/name-tag', requireAdmin, (req, res) => {
  const submissions = db
    .prepare(
      `SELECT m.name AS memberName, n.request_type AS requestType, n.day AS day,
              n.description AS description, n.created_at AS createdAt
       FROM name_tag_requests n
       JOIN members m ON m.id = n.member_id
       ORDER BY n.created_at DESC`
    )
    .all()
    .map((r) => ({
      timestamp: formatTimestamp(r.createdAt),
      memberName: r.memberName,
      requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
      dayLabel: DAY_LABELS[r.day] || r.day,
      description: r.description || '—',
    }));

  res.render('admin-name-tag', { title: 'Name Tag Requests', submissions });
});

module.exports = router;
