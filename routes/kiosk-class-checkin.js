// Class Check-In: a second, independent kiosk surface for checking
// students into (and out of) one specific class (not the day's whole
// roster - see routes/kiosk.js's own comment on why "present" from the
// main portal deliberately never touches a class roster's attendance).
// Gated behind the shared 4-digit PIN (utils/classCheckinPin.js, managed
// under Settings) rather than any per-user login - same reasoning as the
// rest of the kiosk: members and staff never get portal accounts, and
// this is meant to be usable by whichever staff member is running a
// particular class that hour, not tied to one person's credentials.
//
// The PIN unlocks this whole surface for the current browser session
// (req.session.classCheckinUnlocked), not just one request - re-entering
// it for every single scan would defeat the point of a kiosk. A
// "Done" button (day picker) clears it early; otherwise it lasts as
// long as the session cookie itself (8 hours - server.js).
//
// Flow: PIN -> pick a day (Monday/Wednesday) -> that day's class list
// (Hour filter) -> a class's own attendance sheet, which is also where
// Check In and Check Out live (no separate "class detail" page - picking
// a class goes straight to its attendance).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { isValidDay, DAY_LABELS } = require('../utils/days');
const { allClassesList, ensureDayRoster, HOUR_POSITIONS } = require('../utils/classSchedule');
const { buildRosterGridData } = require('../utils/rosterGrid');
const { verifyClassCheckinPin } = require('../utils/classCheckinPin');
const { findMemberByBarcodeOrName } = require('../utils/memberLookup');
const pinLimiter = require('../utils/classCheckinPinRateLimit');
const { createRateLimiter } = require('../utils/rateLimit');

// Separate from the main portal's own checkinLimiter (routes/kiosk.js) -
// same generous per-kiosk-device threshold, tuned the same way, just its
// own independent counter so heavy traffic on one surface never throttles
// the other. Shared by both check-in and check-out scans (one device, one
// realistic ceiling on how fast a person can actually use it).
const classScanLimiter = createRateLimiter({ windowMs: 60 * 1000, maxAttempts: 40 });

const SCAN_MODES = ['checkin', 'checkout'];

function requireUnlocked(req, res, next) {
  if (req.session && req.session.classCheckinUnlocked) return next();
  res.redirect('/kiosk/class-checkin');
}

// Loads a class with the same computed display fields (timeLabel,
// gradeLabel, dayLabel, teacherNames/assistantNames) the admin Classes
// tab and this router's own class list use, so a class looks identical
// wherever it's shown - see allClassesList in utils/classSchedule.js.
async function findClassWithLabels(id) {
  const raw = await db.prepare('SELECT day FROM classes WHERE id = ?').get(id);
  if (!raw) return null;
  return (await allClassesList(raw.day)).find((c) => c.id === id) || null;
}

router.get('/', (req, res) => {
  if (req.session && req.session.classCheckinUnlocked) return res.redirect('/kiosk/class-checkin/classes');
  res.render('kiosk-class-checkin-pin', { title: 'Class Check-In', error: null });
});

router.post('/unlock', async (req, res) => {
  if (pinLimiter.isRateLimited(req.ip)) {
    return res.render('kiosk-class-checkin-pin', {
      title: 'Class Check-In',
      error: 'Too many attempts. Please wait a few minutes and try again.',
    });
  }
  const pin = (req.body.pin || '').trim();
  if (!(await verifyClassCheckinPin(pin))) {
    pinLimiter.recordFailure(req.ip);
    return res.render('kiosk-class-checkin-pin', { title: 'Class Check-In', error: 'Incorrect PIN.' });
  }
  pinLimiter.recordSuccess(req.ip);
  req.session.classCheckinUnlocked = true;
  res.redirect('/kiosk/class-checkin/classes');
});

router.post('/lock', (req, res) => {
  if (req.session) delete req.session.classCheckinUnlocked;
  res.redirect('/kiosk');
});

// Day picker - two large Monday/Wednesday buttons, the top level of the
// unlocked flow (also where "Done" lives, same spot it occupied on the
// old flat class list).
router.get('/classes', requireUnlocked, (req, res) => {
  res.render('kiosk-class-checkin-days', { title: 'Class Check-In' });
});

// That day's classes, with an Hour dropdown to narrow the list - mirrors
// the admin Classes tab's own day+hour filter pattern (see
// routes/admin-rosters.js), minus the day dropdown itself since the day
// is already fixed by the URL here.
router.get('/classes/:day', requireUnlocked, async (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });
  const hourFilter = HOUR_POSITIONS.includes(parseInt(req.query.hour, 10)) ? parseInt(req.query.hour, 10) : null;
  let classes = await allClassesList(day);
  if (hourFilter) classes = classes.filter((c) => c.hour_position === hourFilter);
  res.render('kiosk-class-checkin-classes', {
    title: 'Class Check-In',
    day,
    dayLabel: DAY_LABELS[day],
    classes,
    hourFilter,
    hourPositions: HOUR_POSITIONS,
  });
});

// Picking a class goes straight to its attendance sheet - Check In and
// Check Out live here now (no separate class-detail page in between).
// Read-only, today-only - not the full multi-week admin grid
// (routes/admin-rosters.js), deliberately: this screen is reachable by
// anyone with the shared PIN, not just a logged-in admin, so it only
// ever shows the one day that matters for "who's checked into this class
// right now" rather than a term's worth of history.
router.get('/classes/:id/attendance', requireUnlocked, async (req, res) => {
  const cls = await findClassWithLabels(parseInt(req.params.id, 10));
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(cls.roster_id);
  // roster_id is nullable (ON DELETE SET NULL) and isn't filled in until
  // ensureClassRoster's first call for this class - see resolveScan below,
  // which already guards the same gap.
  if (!roster) return res.status(404).render('404', { title: 'Not Found' });
  const today = todayISO();
  const grid = await buildRosterGridData(roster, [today]);
  res.render('kiosk-class-checkin-attendance', {
    title: `Attendance - ${cls.class_name}`,
    cls,
    dateLabel: formatDateLong(today),
    rows: grid.rows,
    summary: grid.summary[0] || { present: 0, late: 0, absent: 0 },
  });
});

router.get('/classes/:id/scan', requireUnlocked, async (req, res) => {
  const cls = await findClassWithLabels(parseInt(req.params.id, 10));
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  const mode = SCAN_MODES.includes(req.query.mode) ? req.query.mode : 'checkin';
  res.render('kiosk-class-checkin-scan', {
    title: `${mode === 'checkout' ? 'Check Out' : 'Check In'} - ${cls.class_name}`,
    cls,
    mode,
    dateLabel: formatDateLong(todayISO()),
  });
});

// Shared setup for both scan actions below: resolves the member (by
// barcode or, failing that, by exact name - see utils/memberLookup.js),
// the class, and whether the class is even in session today. Returns
// null (having already sent a JSON error response) if any of that fails,
// so each route just does `const ctx = await resolveScan(...); if (!ctx) return;`.
async function resolveScan(req, res) {
  const classId = parseInt(req.params.id, 10);
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.roster_id) {
    res.json({ ok: false, message: 'Class not found.' });
    return null;
  }

  const { member, ambiguous } = await findMemberByBarcodeOrName(req.body.barcode);
  if (ambiguous) {
    res.json({ ok: false, message: 'More than one member has that name - please scan a barcode instead.' });
    return null;
  }
  if (!member) {
    res.json({ ok: false, message: 'Not recognized. Please see an attendant.' });
    return null;
  }

  const today = todayISO();
  // A class roster has no session dates of its own - it borrows them
  // from the day's Student roster (see utils/rosterGrid.js's own
  // comment) - so "is this class actually in session today" is really
  // "does the Student roster have today as a session date", not
  // anything tracked against the class's own roster_id.
  const studentRosterId = await ensureDayRoster(cls.day, 'student');
  const inSessionToday = await db
    .prepare('SELECT 1 FROM roster_dates WHERE roster_id = ? AND session_date = ?')
    .get(studentRosterId, today);
  if (!inSessionToday) {
    res.json({ ok: false, message: `${cls.class_name} isn't in session today.` });
    return null;
  }

  const enrolled = await db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(cls.roster_id, member.id);
  if (!enrolled) {
    res.json({ ok: false, message: `${member.name} is not enrolled in ${cls.class_name}.` });
    return null;
  }

  return { cls, member, today };
}

router.post('/classes/:id/scan/checkin', requireUnlocked, async (req, res) => {
  if (classScanLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  classScanLimiter.recordAttempt(req.ip);

  const ctx = await resolveScan(req, res);
  if (!ctx) return;
  const { cls, member, today } = ctx;

  const existing = await db
    .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(member.id, cls.roster_id, today);
  if (existing && existing.status === 'present') {
    return res.json({
      ok: true,
      alreadyChecked: true,
      name: member.name,
      message: `${member.name} is already checked in to ${cls.class_name}.`,
    });
  }

  // Overwrites any existing status unconditionally - if this member was
  // marked absent or late on this class's attendance sheet earlier,
  // actually checking in should override that, the same way the main
  // portal's own check-in already does (routes/kiosk.js).
  await db
    .prepare(
      `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source)
       VALUES (?, ?, ?, 'present', ?, 'kiosk_class_checkin')
       ON CONFLICT(member_id, roster_id, session_date)
       DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk_class_checkin', recorded_at = now_text()`
    )
    .run(member.id, cls.roster_id, today, Date.now());

  res.json({ ok: true, name: member.name, message: `Welcome, ${member.name}!` });
});

// Records a checkout time scoped to this class's own roster - a separate
// checkouts row from the main portal's numbered pickup checkout
// (routes/checkout.js), with no pickup number at all (number = NULL,
// which checkouts.number now allows - see db/schema.sql/db/index.js).
// Doesn't require a prior check-in: staff may need to check a member out
// even if their check-in was missed or done elsewhere, the same
// leniency the main portal's own checkout already has.
router.post('/classes/:id/scan/checkout', requireUnlocked, async (req, res) => {
  if (classScanLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-outs from this device right now. Please wait a moment and try again.' });
  }
  classScanLimiter.recordAttempt(req.ip);

  const ctx = await resolveScan(req, res);
  if (!ctx) return;
  const { cls, member, today } = ctx;

  const existing = await db
    .prepare('SELECT check_out_time FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(member.id, cls.roster_id, today);
  if (existing) {
    return res.json({
      ok: true,
      alreadyChecked: true,
      name: member.name,
      message: `${member.name} is already checked out of ${cls.class_name}.`,
    });
  }

  await db
    .prepare(
      `INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(member_id, roster_id, session_date)
       DO UPDATE SET check_out_time = excluded.check_out_time, recorded_at = now_text()`
    )
    .run(member.id, cls.roster_id, today, Date.now());

  res.json({ ok: true, name: member.name, message: `${member.name} checked out of ${cls.class_name}.` });
});

module.exports = router;
