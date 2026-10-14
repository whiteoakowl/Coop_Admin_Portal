const express = require('express');
const router = express.Router();
const db = require('../db');
const { todayISO, formatDateLong } = require('../utils/dates');
const { getMemberRostersForDate, ensureMemberOnTodayRoster } = require('../utils/rosters');
const { familyOf } = require('../utils/members');
const { memberScansTaskAtCheckin } = require('../utils/setup');
const { findTaskItemByBarcode, findSetupCleanupBypassBadge, taskAlreadyLoggedByAnotherMember } = require('../utils/taskList');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { createRateLimiter } = require('../utils/rateLimit');
const { verifyClassCheckinPin } = require('../utils/classCheckinPin');
const fullscreenPinLimiter = require('../utils/classCheckinPinRateLimit');

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

// A real request: "exiting full screen on kiosk should ask for an id
// number, otherwis it's stays in full screen kiosk mode. the id number
// is the class check in id number." public/js/fullscreen-toggle.js
// already gates every OTHER portal's own Full Screen button behind the
// shared Class Check-In PIN via routes/admin.js's POST /admin/fullscreen/
// verify-pin - but that route is requireAdmin, and the kiosk (like every
// other kiosk route here) has no admin session to satisfy it. Same PIN,
// same shared classCheckinPinRateLimit instance (so a burst of wrong
// guesses on one door counts against both), no auth required - matches
// routes/kiosk-class-checkin.js's own POST /unlock exactly.
router.post('/fullscreen/verify-pin', async (req, res) => {
  if (fullscreenPinLimiter.isRateLimited(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const pin = (req.body.pin || '').trim();
  if (!(await verifyClassCheckinPin(pin))) {
    fullscreenPinLimiter.recordFailure(req.ip);
    return res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
  }
  fullscreenPinLimiter.recordSuccess(req.ip);
  res.json({ ok: true });
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
  // A real request: "even if a member doesn't have a schedule they
  // should still be able to check in and out and they will
  // automatically be added to the roster for that day." A no-op on any
  // day this doesn't apply to (utils/rosters.js's own
  // ensureMemberOnTodayRoster) - the second lookup only finds something
  // new when it actually added the member to today's day-level roster.
  let rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    await ensureMemberOnTodayRoster(member, today);
    rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  }
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  // A real bug report: "people assigned to setup were able to check in
  // without a badge, which is not allowed." Computed before anything is
  // written - mirrors routes/checkout.js's own memberNeedsSetupBadgeAtCheckout
  // check, which already withholds recordCheckout the same way. day is
  // derived from whichever roster(s) this member is actually scheduled on
  // today (schedule_day), not a separately re-derived "today's real
  // weekday" - rosters can include a class roster alongside the day's own
  // Parent/Student one, but they all share the same day. Students never
  // scan one either way (member_type check).
  const day = rosters.find((r) => r.schedule_day)?.schedule_day || null;
  const needsTaskScan = member.member_type !== 'student' && day && (await memberScansTaskAtCheckin(member.id, day));

  const now = Date.now();
  // One lookup per roster this member is on today (almost always 1, at
  // most a couple) - each is independent of the others, so run them
  // concurrently instead of one at a time.
  const existingRows = await Promise.all(
    rosters.map((r) => db.prepare('SELECT status, task_scanned_at FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(member.id, r.id, today))
  );
  const alreadyPresent = existingRows.every((existing) => existing && existing.status === 'present');

  if (alreadyPresent) {
    // A member marked present some OTHER way (an admin's own manual
    // override on the Attendance grid, say) without ever going through
    // the badge scan below still genuinely needs to log their task - this
    // re-offers it instead of a flat "already checked in." A member who
    // scanned their name tag here but never finished the badge scan can't
    // reach this branch at all anymore (see the needsTaskScan block
    // further down - no attendance row is written for them until that
    // scan actually succeeds), so this is no longer the "resume an
    // interrupted kiosk flow" case it originally guarded.
    if (needsTaskScan && existingRows.some((r) => r.task_scanned_at == null)) {
      return res.json({ ok: true, memberType: 'parent-taskscan', memberId: member.id, name: member.name });
    }
    return res.json({
      ok: true,
      alreadyChecked: true,
      name: member.name,
      message: `${member.name}, you're already checked in today.`,
    });
  }

  if (needsTaskScan) {
    // No attendance row is written yet - /checkin/task-scan below creates
    // it (status 'present' together with whichever task gets scanned) once
    // the badge is actually confirmed. Re-scanning this same name tag
    // before that happens lands right back here every time (still no
    // 'present' row to find), so there's no separate "resume" path needed.
    return res.json({ ok: true, memberType: 'parent-taskscan', memberId: member.id, name: member.name });
  }

  const upsert = db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source)
     VALUES (?, ?, ?, 'present', ?, 'kiosk')
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk', recorded_at = now_text()`
  );
  // Each roster gets its own row (member_id, roster_id, session_date) -
  // writes are independent of one another, so run them concurrently.
  await Promise.all(rosters.map((r) => upsert.run(member.id, r.id, today, now)));

  res.json({ ok: true, name: member.name, message: `Thank you for checking in, ${member.name}!` });
});

// Step 2 ("log on check in" members only): scan the Setup/Cleanup badge
// for the task about to be done. A real bug report ("people assigned to
// setup were able to check in without a badge") means step 1 above no
// longer writes this member present at all - this is the FIRST write for
// them today, creating the attendance row (status 'present' together with
// whichever task gets scanned) rather than updating one that doesn't
// exist yet, mirroring routes/checkout.js's own recordCheckout (called
// only from /checkout/task-scan, never /checkout/scan, for the exact same
// reason). Once written, routes/checkout.js's own /checkout/scan can tell
// this member already logged their task here and skip asking again at
// checkout, carrying the same task_item_id into the checkouts row it
// creates then. Mirrors /checkout/task-scan almost exactly, including the
// same bypass-badge fallback (findSetupCleanupBypassBadge) for a member
// with no card of their own to scan.
router.post('/checkin/task-scan', async (req, res) => {
  if (checkinLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  checkinLimiter.recordAttempt(req.ip);

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
  // which is meant to be reused by anyone without their own card). Same
  // check routes/checkout.js's own task-scan step uses, so a task
  // already logged at check-in by someone else is caught here too, and
  // vice versa.
  if (task && (await taskAlreadyLoggedByAnotherMember(task.id, today, member.id))) {
    return res.json({ ok: false, message: `"${task.description}" has already been logged today. Please scan a different Setup/Cleanup badge.` });
  }

  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  const now = Date.now();
  const taskItemId = task ? task.id : null;
  const upsert = db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source, task_item_id, task_scanned_at)
     VALUES (?, ?, ?, 'present', ?, 'kiosk', ?, ?)
     ON CONFLICT(member_id, roster_id, session_date)
     DO UPDATE SET status = 'present', check_in_time = excluded.check_in_time, source = 'kiosk', recorded_at = now_text(), task_item_id = excluded.task_item_id, task_scanned_at = excluded.task_scanned_at`
  );
  // Independent per-roster writes (different roster_id each time) - run
  // concurrently instead of one at a time.
  await Promise.all(rosters.map((r) => upsert.run(member.id, r.id, today, now, taskItemId, now)));

  // A real request: "after parent scans their setup/cleanup badge it
  // should ask if they have a 2nd setup/cleanup badge to scan, with yes
  // and no buttons." message already carries the eventual "all done"
  // text so a "No" answer (see public/js/kiosk-checkin.js) can show it
  // immediately with no second round trip - needsSecondBadgeChoice just
  // tells the client to ask before actually finishing.
  res.json({ ok: true, name: member.name, needsSecondBadgeChoice: true, message: `Thank you for checking in, ${member.name}!` });
});

// Step 3 (optional): a member covering two Setup/Cleanup jobs the same
// day (see setup_task_assignments.task_item_id_2's own comment) scans a
// second badge after answering "Yes" to the step-2 prompt above. Mirrors
// /checkin/task-scan exactly, writing onto task_item_id_2/
// task_scanned_at_2 instead of the first slot.
router.post('/checkin/task-scan-2', async (req, res) => {
  if (checkinLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  checkinLimiter.recordAttempt(req.ip);

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

  if (task && (await taskAlreadyLoggedByAnotherMember(task.id, today, member.id))) {
    return res.json({ ok: false, message: `"${task.description}" has already been logged today. Please scan a different Setup/Cleanup badge.` });
  }

  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  const now = Date.now();
  const taskItemId = task ? task.id : null;
  const update = db.prepare('UPDATE attendance SET task_item_id_2 = ?, task_scanned_at_2 = ? WHERE member_id = ? AND roster_id = ? AND session_date = ?');
  // Independent per-roster writes (different roster_id each time) - run
  // concurrently instead of one at a time.
  await Promise.all(rosters.map((r) => update.run(taskItemId, now, member.id, r.id, today)));

  // A real request: "also, add asking if you did a 3rd job" - same
  // needsSecondBadgeChoice idea as /checkin/task-scan above, one slot
  // further.
  res.json({ ok: true, name: member.name, needsThirdBadgeChoice: true, message: `Thank you for checking in, ${member.name}!` });
});

// Step 4 (optional): a member covering three Setup/Cleanup jobs the same
// day scans a third badge after answering "Yes" to the step-3 prompt
// above. Mirrors /checkin/task-scan-2 exactly, writing onto the 3rd slot.
router.post('/checkin/task-scan-3', async (req, res) => {
  if (checkinLimiter.isLimited(req.ip)) {
    return res.json({ ok: false, message: 'Too many check-ins from this device right now. Please wait a moment and try again.' });
  }
  checkinLimiter.recordAttempt(req.ip);

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

  if (task && (await taskAlreadyLoggedByAnotherMember(task.id, today, member.id))) {
    return res.json({ ok: false, message: `"${task.description}" has already been logged today. Please scan a different Setup/Cleanup badge.` });
  }

  const rosters = (await getMemberRostersForDate(member.id, today)).filter((r) => r.category !== 'Class Roster');
  if (rosters.length === 0) {
    return res.json({ ok: false, message: `${member.name} is not scheduled for a roster today.` });
  }

  const now3 = Date.now();
  const taskItemId3 = task ? task.id : null;
  const update3 = db.prepare('UPDATE attendance SET task_item_id_3 = ?, task_scanned_at_3 = ? WHERE member_id = ? AND roster_id = ? AND session_date = ?');
  await Promise.all(rosters.map((r) => update3.run(taskItemId3, now3, member.id, r.id, today)));

  res.json({ ok: true, name: member.name, message: `Thank you for checking in, ${member.name}!` });
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

  // 'admin', not just 'parent' - a real bug report: "admins should still
  // be considered parents everywhere" - a family whose only adult member
  // record is admin-typed otherwise never turns up on Find a Parent.
  const parents = (await familyOf(student.id)).filter((m) => m.member_type === 'parent' || m.member_type === 'admin');
  if (parents.length === 0) {
    return res.json({ ok: true, studentName: student.name, parents: [], cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
  }

  // Same rendering pipeline as the Members "View Cards" dialog and the
  // Design/Print Schedule Card print run - the parent's schedule here
  // looks exactly like their printed Schedule Card because it IS that
  // card, not a separate hand-built view.
  const template = await getScheduleCardTemplate();
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  // scheduleCardDataForMember(p) is its own independent set of DB reads
  // per parent - run them concurrently instead of one parent at a time
  // (Promise.all preserves `parents`' own order, same as the loop did).
  const parentData = await Promise.all(
    parents.map(async (p) => ({
      name: p.name,
      html: NameTagRenderCore.renderBadgeElements(template.elements, await scheduleCardDataForMember(p)),
      bgCss,
    }))
  );

  res.json({ ok: true, studentName: student.name, parents: parentData, cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
});

module.exports = router;
