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

// Step 1: scan barcode, look up member.
router.post('/checkout/scan', async (req, res) => {
  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = await db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  const rosters = getMemberRostersForDate(member.id, today);
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  // A member on multiple rosters today checks out of all of them at once
  // with the same pickup number, so any existing number (they'll all match) works here.
  const existing = await db
    .prepare('SELECT number FROM checkouts WHERE member_id = ? AND session_date = ?')
    .get(member.id, today);

  res.json({
    ok: true,
    memberId: member.id,
    name: member.name,
    existingNumber: existing ? existing.number : null,
  });
});

// Step 2: submit the chosen pickup number (1-80) - recorded across every
// roster the member is scheduled on today.
router.post('/checkout/submit', async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const number = parseInt(req.body.number, 10);
  const today = todayISO();

  if (!memberId || !Number.isInteger(number) || number < 1 || number > 80) {
    return res.json({ ok: false, message: 'Please select a valid number between 1 and 80.' });
  }

  const member = await db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(memberId);
  if (!member) {
    return res.json({ ok: false, message: 'Member not found.' });
  }

  const rosters = getMemberRostersForDate(member.id, today);
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  // datetime('now') - SQLite-only, deliberately left as-is (see
  // MIGRATION.md's special-cases list); not touched by this routine
  // async/await pass.
  const upsert = db.prepare(
    `INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET number = excluded.number, check_out_time = excluded.check_out_time, recorded_at = datetime('now')`
  );
  const now = Date.now();
  for (const roster of rosters) {
    await upsert.run(member.id, roster.id, today, number, now);
  }

  res.json({ ok: true, name: member.name, number, message: `${member.name} checked out with #${number}.` });
});

module.exports = router;
