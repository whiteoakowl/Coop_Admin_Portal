const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');
const { familyOf } = require('../utils/members');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { createRateLimiter } = require('../utils/rateLimit');

// Both scan endpoints are unauthenticated by design - a member's barcode
// is their own name specifically so it can be typed at the kiosk as well
// as scanned, with no login of any kind (members never get portal
// accounts; the kiosk is the entire member-facing surface). That's
// intentional and not something this limiter changes. What it guards
// against is a *script* driving either endpoint at a volume no person
// physically standing at one kiosk ever would - the caps below are set
// well above a genuinely busy drop-off (many families scanning in quick
// succession) and only bite something sending requests far faster than a
// human walking up, scanning, and stepping aside possibly could.
const checkinLimiter = createRateLimiter({ windowMs: 60 * 1000, maxAttempts: 40 });
const findParentLimiter = createRateLimiter({ windowMs: 60 * 1000, maxAttempts: 40 });

// Full kiosk landing screen (Check In/Out, Floater Assignments, forms) -
// not the site's homepage anymore (that's now the member/staff login),
// reached via the "Full Kiosk Screen" quick link in admin Settings.
router.get('/', (req, res) => {
  res.render('kiosk-home', { title: 'Kiosk' });
});

// --- Check-in kiosk ---

router.get('/checkin', (req, res) => {
  res.render('kiosk-checkin', {
    title: 'Check In',
    dateLabel: formatDateLong(todayISO()),
  });
});

router.post('/checkin/scan', async (req, res) => {
  if (checkinLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  checkinLimiter.recordAttempt(req.ip);

  const barcode = (req.body.barcode || '').trim();
  const today = todayISO();

  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const member = await db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!member) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }

  // Excludes class rosters (rosters.category === 'Class Roster', see
  // ensureClassRoster in utils/classSchedule.js) - this main portal only
  // ever marks someone present on the day's own Parent/Student roster.
  // A specific class's attendance is recorded only by scanning in
  // through that class's own Check-In screen (routes/kiosk-class-
  // checkin.js) - two independent presence signals by design, not two
  // paths to the same one, so "checked in at the front door" and
  // "actually sat in this specific classroom" stay distinguishable.
  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  const now = Date.now();
  let alreadyPresent = true;
  for (const r of rosters) {
    const existing = await db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(member.id, r.id, today);
    if (!existing || existing.status !== 'present') alreadyPresent = false;
  }

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
     DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk', recorded_at = now_text()`
  );
  for (const r of rosters) {
    await upsert.run(member.id, r.id, today, now);
  }

  res.json({ ok: true, name: member.name, message: `Welcome to Co-op, ${member.name}!` });
});

// --- Find a Parent ---
//
// A child (or anyone at the kiosk) scans a student's name tag, and the
// screen shows where each of that student's parents is scheduled today
// (their teaching/assistant assignments) - so they can be found in
// person. Read-only: doesn't touch attendance at all.

router.get('/find-parent', (req, res) => {
  res.render('kiosk-find-parent', { title: 'Find a Parent' });
});

router.post('/find-parent/scan', async (req, res) => {
  if (findParentLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many lookups from this device right now. Please wait a moment and try again.' });
  }
  findParentLimiter.recordAttempt(req.ip);

  const barcode = (req.body.barcode || '').trim();
  if (!barcode) {
    return res.json({ ok: false, message: 'No barcode scanned.' });
  }

  const student = await db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
  if (!student) {
    return res.json({ ok: false, message: 'Barcode not recognized. Please see an attendant.' });
  }
  if (student.member_type !== 'student') {
    return res.json({ ok: false, message: `${student.name} isn't a student - scan a student's name tag.` });
  }

  const parents = (await familyOf(student.id)).filter((m) => m.member_type === 'parent');
  if (parents.length === 0) {
    return res.json({ ok: true, studentName: student.name, parents: [], cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
  }

  // Same rendering pipeline as the Members "View Cards" dialog and the
  // Design/Print Schedule Card print run - the parent's schedule here
  // looks exactly like their printed Schedule Card because it IS that
  // card, not a separate hand-built view.
  const template = await getScheduleCardTemplate();
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const parentData = [];
  for (const p of parents) {
    parentData.push({
      name: p.name,
      html: NameTagRenderCore.renderBadgeElements(template.elements, await scheduleCardDataForMember(p)),
      bgCss,
    });
  }

  res.json({ ok: true, studentName: student.name, parents: parentData, cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
});

module.exports = router;
