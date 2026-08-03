const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, sessionDayForDate, formatDateLong } = require('../utils/dates');

// --- Check-in kiosk ---

router.get('/checkin', (req, res) => {
  const today = todayISO();
  const sessionDay = sessionDayForDate(today);
  res.render('kiosk-checkin', {
    title: 'Check In',
    sessionDay,
    dateLabel: formatDateLong(today),
  });
});

router.post('/checkin/scan', (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();
  const sessionDay = sessionDayForDate(today);

  if (!sessionDay) {
    return res.json({ ok: false, message: 'There is no session today. Sessions run Monday and Wednesday.' });
  }
  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  const existing = db
    .prepare('SELECT * FROM attendance WHERE member_id = ? AND session_date = ?')
    .get(member.id, today);

  if (existing && existing.status === 'present') {
    return res.json({
      ok: true,
      alreadyChecked: true,
      name: member.name,
      message: `${member.name}, you're already checked in today.`,
    });
  }

  db.prepare(
    `INSERT INTO attendance (member_id, session_day, session_date, status, source)
     VALUES (?, ?, ?, 'present', 'kiosk')
     ON CONFLICT(member_id, session_date)
     DO UPDATE SET status = 'present', source = 'kiosk', recorded_at = datetime('now')`
  ).run(member.id, sessionDay, today);

  res.json({ ok: true, name: member.name, message: `Welcome, ${member.name}!` });
});

module.exports = router;
