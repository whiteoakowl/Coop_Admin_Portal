// Class Check-In: a second, independent kiosk surface for checking
// students into one specific class (not the day's whole roster - see
// routes/kiosk.js's own comment on why "present" from the main portal
// deliberately never touches a class roster's attendance). Gated behind
// the shared 4-digit PIN (utils/classCheckinPin.js, managed under
// Settings) rather than any per-user login - same reasoning as the rest
// of the kiosk: members and staff never get portal accounts, and this
// is meant to be usable by whichever staff member is running a
// particular class that hour, not tied to one person's credentials.
//
// The PIN unlocks this whole surface for the current browser session
// (req.session.classCheckinUnlocked), not just one request - re-entering
// it for every single scan would defeat the point of a kiosk. A
// "Done" button (classes list) clears it early; otherwise it lasts as
// long as the session cookie itself (8 hours - server.js).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { isValidDay } = require('../utils/days');
const { allClassesList, ensureDayRoster, HOUR_POSITIONS } = require('../utils/classSchedule');
const { buildRosterGridData } = require('../utils/rosterGrid');
const { verifyClassCheckinPin } = require('../utils/classCheckinPin');
const pinLimiter = require('../utils/classCheckinPinRateLimit');
const { createRateLimiter } = require('../utils/rateLimit');

// Separate from the main portal's own checkinLimiter (routes/kiosk.js) -
// same generous per-kiosk-device threshold, tuned the same way, just its
// own independent counter so heavy traffic on one surface never throttles
// the other.
const classScanLimiter = createRateLimiter({ windowMs: 60 * 1000, maxAttempts: 40 });

function requireUnlocked(req, res, next) {
  if (req.session && req.session.classCheckinUnlocked) return next();
  res.redirect('/kiosk/class-checkin');
}

// Loads a class with the same computed display fields (timeLabel,
// gradeLabel, dayLabel, teacherNames/assistantNames) the admin Classes
// tab and this router's own class list use, so a class looks identical
// wherever it's shown - see allClassesList in utils/classSchedule.js.
function findClassWithLabels(id) {
  const raw = db.prepare('SELECT day FROM classes WHERE id = ?').get(id);
  if (!raw) return null;
  return allClassesList(raw.day).find((c) => c.id === id) || null;
}

router.get('/', (req, res) => {
  if (req.session && req.session.classCheckinUnlocked) return res.redirect('/kiosk/class-checkin/classes');
  res.render('kiosk-class-checkin-pin', { title: 'Class Check-In', error: null });
});

router.post('/unlock', (req, res) => {
  if (pinLimiter.isRateLimited(req.ip)) {
    return res.render('kiosk-class-checkin-pin', {
      title: 'Class Check-In',
      error: 'Too many attempts. Please wait a few minutes and try again.',
    });
  }
  const pin = (req.body.pin || '').trim();
  if (!verifyClassCheckinPin(pin)) {
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

router.get('/classes', requireUnlocked, (req, res) => {
  const dayFilter = isValidDay(req.query.day) ? req.query.day : '';
  const hourFilter = HOUR_POSITIONS.includes(parseInt(req.query.hour, 10)) ? parseInt(req.query.hour, 10) : null;
  let classes = allClassesList(dayFilter || null);
  if (hourFilter) classes = classes.filter((c) => c.hour_position === hourFilter);
  res.render('kiosk-class-checkin-classes', {
    title: 'Class Check-In',
    classes,
    dayFilter,
    hourFilter,
    hourPositions: HOUR_POSITIONS,
  });
});

router.get('/classes/:id', requireUnlocked, (req, res) => {
  const cls = findClassWithLabels(parseInt(req.params.id, 10));
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  res.render('kiosk-class-checkin-detail', { title: cls.class_name, cls });
});

router.get('/classes/:id/scan', requireUnlocked, (req, res) => {
  const cls = findClassWithLabels(parseInt(req.params.id, 10));
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  res.render('kiosk-class-checkin-scan', { title: `Check In - ${cls.class_name}`, cls, dateLabel: formatDateLong(todayISO()) });
});

router.post('/classes/:id/scan', requireUnlocked, (req, res) => {
  if (classScanLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  classScanLimiter.recordAttempt(req.ip);

  const classId = parseInt(req.params.id, 10);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.roster_id) return res.json({ ok: false, message: 'Class not found.' });

  const barcode = (req.body.barcode || '').trim();
  if (!barcode) return res.json({ ok: false, message: 'No barcode scanned.' });

  const member = db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });

  const today = todayISO();
  // A class roster has no session dates of its own - it borrows them
  // from the day's Student roster (see utils/rosterGrid.js's own
  // comment) - so "is this class actually meeting today" is really
  // "does the Student roster have today as a session date", not
  // anything tracked against the class's own roster_id.
  const studentRosterId = ensureDayRoster(cls.day, 'student');
  const inSessionToday = db
    .prepare('SELECT 1 FROM roster_dates WHERE roster_id = ? AND session_date = ?')
    .get(studentRosterId, today);
  if (!inSessionToday) {
    return res.json({ ok: false, message: `${cls.class_name} isn't in session today.` });
  }

  const enrolled = db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(cls.roster_id, member.id);
  if (!enrolled) {
    return res.json({ ok: false, message: `${member.name} is not enrolled in ${cls.class_name}.` });
  }

  const existing = db
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

  db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source)
     VALUES (?, ?, ?, 'present', ?, 'kiosk_class_checkin')
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk_class_checkin', recorded_at = datetime('now')`
  ).run(member.id, cls.roster_id, today, Date.now());

  res.json({ ok: true, name: member.name, message: `Welcome, ${member.name}!` });
});

// Read-only, today-only attendance snapshot - not the full multi-week
// admin grid (routes/admin-rosters.js), deliberately: this screen is
// reachable by anyone with the shared PIN, not just a logged-in admin,
// so it only ever shows the one day that matters for "who's checked into
// this class right now" rather than a term's worth of history.
router.get('/classes/:id/attendance', requireUnlocked, (req, res) => {
  const cls = findClassWithLabels(parseInt(req.params.id, 10));
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(cls.roster_id);
  const today = todayISO();
  const grid = buildRosterGridData(roster, [today]);
  res.render('kiosk-class-checkin-attendance', {
    title: `Attendance - ${cls.class_name}`,
    cls,
    dateLabel: formatDateLong(today),
    rows: grid.rows,
    summary: grid.summary[0] || { present: 0, late: 0, absent: 0 },
  });
});

module.exports = router;
