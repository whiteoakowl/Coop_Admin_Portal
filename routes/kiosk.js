const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, sessionDayForDate, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDay } = require('../utils/rosters');

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

  const rosters = getMemberRostersForDay(member.id, sessionDay);
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not on a roster for today.` });
  }

  const now = Date.now();
  const alreadyPresent = rosters.every((r) => {
    const existing = db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(member.id, r.id, today);
    return existing && existing.status === 'present';
  });

  if (alreadyPresent) {
    return res.json({
      ok: true,
      alreadyChecked: true,
      name: member.name,
      message: `${member.name}, you're already checked in today.`,
    });
  }

  const upsert = db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source)
     VALUES (?, ?, ?, 'present', ?, 'kiosk')
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk', recorded_at = datetime('now')`
  );
  for (const r of rosters) {
    upsert.run(member.id, r.id, today, now);
  }

  res.json({ ok: true, name: member.name, message: `Welcome, ${member.name}!` });
});

module.exports = router;
