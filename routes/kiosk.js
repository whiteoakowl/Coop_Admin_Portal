const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');
const { defaultDay } = require('../utils/days');

// Full kiosk landing screen (Check In/Out, Floater Assignments, forms) -
// not the site's homepage anymore (that's now the member/staff login),
// reached via the "Full Kiosk Screen" quick link in admin Settings.
router.get('/', (req, res) => {
  res.render('kiosk-home', { title: 'Kiosk', defaultDay: defaultDay() });
});

// --- Check-in kiosk ---

router.get('/checkin', (req, res) => {
  res.render('kiosk-checkin', {
    title: 'Check In',
    dateLabel: formatDateLong(todayISO()),
  });
});

router.post('/checkin/scan', (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  const rosters = getMemberRostersForDate(member.id, today);
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
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
