const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');

router.get('/checkout', (req, res) => {
  res.render('kiosk-checkout', {
    title: 'Check Out',
    dateLabel: formatDateLong(todayISO()),
  });
});

// Pick which of a member's rosters today's checkout applies to: prefer the
// roster they actually checked into today, otherwise fall back to their
// only matching roster for the date.
function resolveRosterForCheckout(memberId, today) {
  const rosters = getMemberRostersForDate(memberId, today);
  if (rosters.length === 0) return null;
  if (rosters.length === 1) return rosters[0];
  const rosterIds = rosters.map((r) => r.id);
  const placeholders = rosterIds.map(() => '?').join(',');
  const checkedIn = db
    .prepare(
      `SELECT roster_id FROM attendance
       WHERE member_id = ? AND session_date = ? AND status = 'present' AND roster_id IN (${placeholders})`
    )
    .get(memberId, today, ...rosterIds);
  if (checkedIn) return rosters.find((r) => r.id === checkedIn.roster_id);
  return rosters[0];
}

// Step 1: scan barcode, look up member.
router.post('/checkout/scan', (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  const roster = resolveRosterForCheckout(member.id, today);
  if (!roster) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  const existing = db
    .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(member.id, roster.id, today);

  res.json({
    ok: true,
    memberId: member.id,
    rosterId: roster.id,
    name: member.name,
    existingNumber: existing ? existing.number : null,
  });
});

// Step 2: submit the chosen pickup number (1-80).
router.post('/checkout/submit', (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const rosterId = parseInt(req.body.rosterId, 10);
  const number = parseInt(req.body.number, 10);
  const today = todayISO();

  if (!memberId || !rosterId || !Number.isInteger(number) || number < 1 || number > 80) {
    return res.json({ ok: false, message: 'Please select a valid number between 1 and 80.' });
  }

  const member = db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(memberId);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ? AND active = 1').get(rosterId);
  if (!member || !roster) {
    return res.json({ ok: false, message: 'Member or roster not found.' });
  }

  db.prepare(
    `INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET number = excluded.number, check_out_time = excluded.check_out_time, recorded_at = datetime('now')`
  ).run(member.id, roster.id, today, number, Date.now());

  res.json({ ok: true, name: member.name, number, message: `${member.name} checked out with #${number}.` });
});

module.exports = router;
