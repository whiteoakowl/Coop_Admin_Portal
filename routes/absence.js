const express = require('express');
const router = express.Router();
const db = require('../db');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');

function loadMembers() {
  return db
    .prepare(
      `SELECT m.id, m.name FROM members m
       JOIN absence_list_members alm ON alm.member_id = m.id
       WHERE m.active = 1 ORDER BY m.name COLLATE NOCASE`
    )
    .all();
}

function loadAbsenceListMember(memberId) {
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN absence_list_members alm ON alm.member_id = m.id
       WHERE m.id = ? AND m.active = 1`
    )
    .get(memberId);
}

router.get('/absence', (req, res) => {
  res.render('absence', {
    title: 'Absence/Late Form',
    members: loadMembers(),
    result: null,
    formValues: { type: 'absence', memberId: '', sessionDate: '', reasonCategory: '', reason: '' },
  });
});

router.post('/absence/submit', (req, res) => {
  const type = req.body.type === 'late' ? 'late' : 'absence';
  const memberId = parseInt(req.body.memberId, 10);
  const sessionDate = (req.body.sessionDate || '').trim();
  const reasonCategory = ['personal', 'medical'].includes(req.body.reasonCategory) ? req.body.reasonCategory : null;
  const reason = (req.body.reason || '').trim() || null;

  const formValues = {
    type,
    memberId: req.body.memberId || '',
    sessionDate,
    reasonCategory: req.body.reasonCategory || '',
    reason: req.body.reason || '',
  };

  const members = loadMembers();
  const member = memberId ? loadAbsenceListMember(memberId) : null;

  if (!member) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      members,
      formValues,
      result: { ok: false, message: 'Please select your name.' },
    });
  }
  if (!isValidISODate(sessionDate)) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      members,
      formValues,
      result: { ok: false, message: 'Please choose a session date.' },
    });
  }
  if (!reasonCategory) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      members,
      formValues,
      result: { ok: false, message: 'Please select Personal or Medical.' },
    });
  }

  const rosters = getMemberRostersForDate(member.id, sessionDate);
  if (rosters.length === 0) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      members,
      formValues,
      result: { ok: false, message: `${member.name} isn't on a roster meeting on ${formatDateLabel(sessionDate)}.` },
    });
  }

  const status = type === 'late' ? 'late' : 'absent';
  let skippedAsPresent = 0;

  for (const roster of rosters) {
    const existing = db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(member.id, roster.id, sessionDate);

    if (existing && existing.status === 'present') {
      skippedAsPresent++;
      continue;
    }

    if (existing) {
      db.prepare(
        `UPDATE attendance SET status = ?, source = 'absence_form', reason_category = ?, reason_text = ?, recorded_at = datetime('now') WHERE id = ?`
      ).run(status, reasonCategory, reason, existing.id);
    } else {
      db.prepare(
        `INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category, reason_text)
         VALUES (?, ?, ?, ?, 'absence_form', ?, ?)`
      ).run(member.id, roster.id, sessionDate, status, reasonCategory, reason);
    }
  }

  const label = type === 'late' ? 'Late notice' : 'Absence';
  let message = `${label} recorded for ${member.name} on ${formatDateLabel(sessionDate)}.`;
  if (skippedAsPresent === rosters.length) {
    message = `${member.name} is already checked in as present for ${formatDateLabel(sessionDate)}, so no change was made.`;
  } else if (skippedAsPresent > 0) {
    message += ' (Already checked in as present on one roster, so that one was left unchanged.)';
  }

  res.render('absence', {
    title: 'Absence/Late Form',
    members,
    formValues: { type: 'absence', memberId: '', sessionDate: '', reasonCategory: '', reason: '' },
    result: { ok: true, message, redirectHome: true },
  });
});

module.exports = router;
