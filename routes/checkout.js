const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, sessionDayForDate, formatDateLong } = require('../utils/dates');

router.get('/checkout', (req, res) => {
  const today = todayISO();
  const sessionDay = sessionDayForDate(today);
  res.render('kiosk-checkout', {
    title: 'Check Out',
    sessionDay,
    dateLabel: formatDateLong(today),
  });
});

// Step 1: scan barcode, look up member.
router.post('/checkout/scan', (req, res) => {
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
    .prepare('SELECT * FROM checkouts WHERE member_id = ? AND session_date = ?')
    .get(member.id, today);

  res.json({
    ok: true,
    memberId: member.id,
    name: member.name,
    existingNumber: existing ? existing.number : null,
  });
});

// Step 2: submit the chosen pickup number (1-80).
router.post('/checkout/submit', (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const number = parseInt(req.body.number, 10);
  const today = todayISO();
  const sessionDay = sessionDayForDate(today);

  if (!sessionDay) {
    return res.json({ ok: false, message: 'There is no session today.' });
  }
  if (!memberId || !Number.isInteger(number) || number < 1 || number > 80) {
    return res.json({ ok: false, message: 'Please select a valid number between 1 and 80.' });
  }

  const member = db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(memberId);
  if (!member) {
    return res.json({ ok: false, message: 'Member not found.' });
  }

  db.prepare(
    `INSERT INTO checkouts (member_id, session_day, session_date, number)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id, session_date)
     DO UPDATE SET number = excluded.number, recorded_at = datetime('now')`
  ).run(member.id, sessionDay, today, number);

  res.json({ ok: true, name: member.name, number, message: `${member.name} checked out with #${number}.` });
});

module.exports = router;
