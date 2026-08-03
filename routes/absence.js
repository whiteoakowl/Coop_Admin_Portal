const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, getUpcomingOccurrences, sessionDayForDate, formatDateLabel } = require('../utils/dates');

function buildUpcomingSessions() {
  const today = todayISO();
  const mondays = getUpcomingOccurrences('monday', 6, today);
  const wednesdays = getUpcomingOccurrences('wednesday', 6, today);
  const all = [...mondays, ...wednesdays].sort();
  return all.map((date) => ({ date, label: formatDateLabel(date) }));
}

router.get('/absence', (req, res) => {
  const members = db
    .prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all();
  res.render('absence', {
    title: 'Report an Absence',
    members,
    sessions: buildUpcomingSessions(),
    result: null,
  });
});

router.post('/absence/submit', (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const sessionDate = (req.body.sessionDate || '').trim();
  const reason = (req.body.reason || '').trim() || null;

  const members = db
    .prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all();
  const sessions = buildUpcomingSessions();

  const sessionDay = sessionDayForDate(sessionDate);
  const member = memberId ? db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(memberId) : null;

  if (!member || !sessionDay) {
    return res.render('absence', {
      title: 'Report an Absence',
      members,
      sessions,
      result: { ok: false, message: 'Please select your name and a valid Monday/Wednesday session.' },
    });
  }

  const existing = db
    .prepare('SELECT * FROM attendance WHERE member_id = ? AND session_date = ?')
    .get(member.id, sessionDate);

  if (existing && existing.status === 'present') {
    return res.render('absence', {
      title: 'Report an Absence',
      members,
      sessions,
      result: {
        ok: true,
        message: `${member.name} is already checked in as present for ${formatDateLabel(sessionDate)}, so no change was made.`,
      },
    });
  }

  if (existing) {
    db.prepare(
      `UPDATE attendance SET status = 'absent', source = 'absence_form', reason = ?, recorded_at = datetime('now') WHERE id = ?`
    ).run(reason, existing.id);
  } else {
    db.prepare(
      `INSERT INTO attendance (member_id, session_day, session_date, status, source, reason)
       VALUES (?, ?, ?, 'absent', 'absence_form', ?)`
    ).run(member.id, sessionDay, sessionDate, reason);
  }

  res.render('absence', {
    title: 'Report an Absence',
    members,
    sessions,
    result: {
      ok: true,
      message: `Absence recorded for ${member.name} on ${formatDateLabel(sessionDate)}.`,
    },
  });
});

module.exports = router;
