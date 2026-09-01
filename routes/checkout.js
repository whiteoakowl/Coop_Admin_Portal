const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');
const { findTaskItemByBarcode, findSetupCleanupBypassBadge, taskAlreadyLoggedByAnotherMember } = require('../utils/taskList');
const { createRateLimiter } = require('../utils/rateLimit');

// Same reasoning as routes/kiosk.js's checkinLimiter - both scan endpoints
// below are unauthenticated by design (a member's own barcode is their
// login), this only caps a script driving them far faster than anyone
// physically standing at the kiosk could.
const checkoutLimiter = createRateLimiter({ windowMs: 60 * 1000, maxAttempts: 40 });

router.get('/checkout', (req, res) => {
  res.render('kiosk-checkout', {
    title: 'Check Out',
    dateLabel: formatDateLong(todayISO()),
  });
});

// Records this member's checkout across every roster they're scheduled on
// today - taskItemId is null for students (who never scan one) and for a
// parent whose scanned task barcode wasn't recognized.
async function recordCheckout(member, rosters, today, taskItemId) {
  const upsert = db.prepare(
    `INSERT INTO checkouts (member_id, roster_id, session_date, task_item_id, check_out_time)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET task_item_id = excluded.task_item_id, check_out_time = excluded.check_out_time, recorded_at = now_text()`
  );
  const now = Date.now();
  for (const roster of rosters) {
    await upsert.run(member.id, roster.id, today, taskItemId, now);
  }
}

// Step 1: scan the member's own name tag. Students are checked out
// immediately with no further step. Parents move on to step 2 (scan the
// Setup/Cleanup badge for the task they completed) instead of the old
// "choose a pickup number 1-80" step.
router.post('/checkout/scan', async (req, res) => {
  if (checkoutLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-outs from this device right now. Please wait a moment and try again.' });
  }
  checkoutLimiter.recordAttempt(req.ip);

  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = await db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  // Excludes class rosters (rosters.category === 'Class Roster') - same
  // reasoning as routes/kiosk.js's own /checkin/scan: the front-door
  // portal only ever checks someone out of the day's own Parent/Student
  // roster, never a specific class's own roster (that's
  // routes/kiosk-class-checkin.js's job, with its own independent
  // check-out screen), so the two presence signals stay independent.
  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  // Same "already done today" guard routes/kiosk.js's own /checkin/scan
  // has (alreadyPresent) and routes/kiosk-class-checkin.js's scan/checkout
  // has (its own `existing` check) - without this, a duplicate scan (a
  // scanner double-fire, or a sibling re-scanning the same badge) just
  // silently overwrote check_out_time with a later, spurious time.
  let alreadyCheckedOut = true;
  for (const r of rosters) {
    const existing = await db.prepare('SELECT 1 FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(member.id, r.id, today);
    if (!existing) alreadyCheckedOut = false;
  }
  if (alreadyCheckedOut) {
    return res.json({
      ok: true,
      alreadyChecked: true,
      memberType: member.member_type === 'student' ? 'student' : 'parent-already-logged',
      name: member.name,
      message: `${member.name}, you're already checked out today.`,
    });
  }

  if (member.member_type === 'student') {
    await recordCheckout(member, rosters, today, null);
    return res.json({ ok: true, memberType: 'student', name: member.name, message: `Thank you for checking out, ${member.name}! Have a great day!` });
  }

  // A real request: "add a dropdown menu to each setup/cleanup team list
  // that asks, log on check in or log on check out ... then if it is
  // marked log on check out, check out requires members to scan name tag
  // then scan setup/cleanup card." A member whose team logs at CHECK IN
  // instead (routes/kiosk.js's own /checkin/task-scan) already has their
  // task recorded on today's attendance row - checkout for them is then
  // as simple as a student's, carrying that same task_item_id over
  // instead of asking again. task_scanned_at (not just task_item_id
  // being non-null) is the actual "already logged" signal - task_item_id
  // legitimately stays null for a bypass-badge scan too (see
  // findSetupCleanupBypassBadge's own comment), which must still count
  // as logged.
  const alreadyLogged = await db
    .prepare('SELECT task_item_id FROM attendance WHERE member_id = ? AND session_date = ? AND task_scanned_at IS NOT NULL LIMIT 1')
    .get(member.id, today);
  if (alreadyLogged) {
    await recordCheckout(member, rosters, today, alreadyLogged.task_item_id);
    return res.json({ ok: true, memberType: 'parent-already-logged', name: member.name, message: `Thank you for checking out, ${member.name}! Have a great day!` });
  }

  res.json({ ok: true, memberType: 'parent', memberId: member.id, name: member.name });
});

// Step 2 (parents only): scan the Setup/Cleanup badge for the task just
// completed, recorded across every roster the parent is scheduled on today.
// A real request: "if someone doesn't have a setup cleanup card to scan
// the admin setup/cleanup card can be scanned to bypass the checkout
// demand for a setup/cleanup card." When the scanned barcode isn't a
// real task, findSetupCleanupBypassBadge checks for that one general,
// not-member-linked bypass badge (seeded once - db/bootstrapPg.js's
// seedIfMissing, printable from Design > Print > Setup/Cleanup Badges)
// before finally giving up - an attendant scans it in place of whichever
// task badge the member doesn't have. Records the same as a genuinely
// unrecognized/no task scan (taskItemId null - see recordCheckout's own
// comment), since a bypass isn't tied to any specific task either.
router.post('/checkout/task-scan', async (req, res) => {
  if (checkoutLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-outs from this device right now. Please wait a moment and try again.' });
  }
  checkoutLimiter.recordAttempt(req.ip);

  const memberId = parseInt(req.body.memberId, 10);
  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = await db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(memberId);
  if (!member) {
    return res.json({ ok: false, message: 'Member not found.' });
  }

  const task = await findTaskItemByBarcode(barcode);
  const bypass = task ? null : await findSetupCleanupBypassBadge(barcode);
  if (!task && !bypass) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  // A real request: "don't allow each setup/cleanup badge to be scanned
  // more than once in a day" - only real tasks (never the bypass badge,
  // which is meant to be reused by anyone without their own card).
  if (task && (await taskAlreadyLoggedByAnotherMember(task.id, today, member.id))) {
    return res.json({ ok: false, message: `"${task.description}" has already been logged today. Please scan a different Setup/Cleanup badge.` });
  }

  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  await recordCheckout(member, rosters, today, task ? task.id : null);
  res.json({ ok: true, name: member.name, message: `Thank you for checking out, ${member.name}! Have a great day!` });
});

module.exports = router;
