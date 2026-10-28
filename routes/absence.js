const express = require('express');
const router = express.Router();
const db = require('../db');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');
const { activeParentAndAdminOptions, familyGroupsByMember, loadFamilyMember } = require('../utils/members');
const { createRateLimiter } = require('../utils/rateLimit');
const { unassignMemberForDate } = require('../utils/substitutes');
const { unassignMemberTasksForDate } = require('../utils/setup');

// Generous cap for real use (a parent reporting for several kids, or
// retrying after a typo) that still stops a script from hammering this
// public, no-login endpoint with repeated attendance-record writes.
const submitLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

// A real request: "Quicklinks have been created for member to quickly
// view ... absence/late form ... When they go to these quick links they
// should be stand alone pages not connected to the kiosk. Member should
// not be able to access the kiosk by going to these pages." /absence is
// the exact same bare URL the Kiosk home screen's own Absence/Late Form
// button links to AND the one a member reaches directly via a Quick
// Link/QR code/bookmark - fromKiosk (true only when reached via
// ?kiosk=1, the tag kiosk-home.ejs's own links now carry) gates the
// "Return to Home Screen" link below (see the view's own hasParentRole
// comment) and the post-submit auto-redirect-to-/kiosk (result.redirectHome).
function isFromKiosk(req) {
  return req.query.kiosk === '1';
}

router.get('/absence', async (req, res) => {
  res.render('absence', {
    title: 'Absence/Late Form',
    parents: await activeParentAndAdminOptions(),
    childrenByParent: await familyGroupsByMember(),
    result: null,
    formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
    fromKiosk: isFromKiosk(req),
  });
});

router.post('/absence/submit', async (req, res) => {
  const fromKiosk = isFromKiosk(req);
  if (submitLimiter.isLimited(req.ip)) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      parents: await activeParentAndAdminOptions(),
      childrenByParent: await familyGroupsByMember(),
      formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
      result: { ok: false, message: 'Too many submissions from this device. Please wait a few minutes and try again.' },
      fromKiosk,
    });
  }
  submitLimiter.recordAttempt(req.ip);

  const type = req.body.type === 'late' ? 'late' : 'absence';
  const parentId = parseInt(req.body.parentId, 10);
  const studentIds = [].concat(req.body.studentIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const sessionDate = (req.body.sessionDate || '').trim();
  const reasonCategory = ['personal', 'medical'].includes(req.body.reasonCategory) ? req.body.reasonCategory : null;
  const reason = (req.body.reason || '').trim() || null;

  const parents = await activeParentAndAdminOptions();
  const childrenByParent = await familyGroupsByMember();
  const formValues = {
    type,
    parentId: req.body.parentId || '',
    studentIds,
    sessionDate,
    reasonCategory: req.body.reasonCategory || '',
    reason: req.body.reason || '',
  };

  function fail(message) {
    return res.render('absence', { title: 'Absence/Late Form', parents, childrenByParent, formValues, result: { ok: false, message }, fromKiosk });
  }

  const parent = parentId ? parents.find((p) => p.id === parentId) : null;
  if (!parent) return fail('Please select your name.');

  const students = [];
  for (const id of studentIds) {
    const student = await loadFamilyMember(id, parentId);
    if (student) students.push(student);
  }
  if (students.length === 0) return fail('Please select at least one name.');

  if (!isValidISODate(sessionDate)) return fail('Please choose a class date.');
  if (!reasonCategory) return fail('Please select Personal or Medical.');

  const namesRecorded = [];

  for (const student of students) {
    const rosters = await getMemberRostersForDate(student.id, sessionDate);
    if (rosters.length === 0) continue;

    const status = type === 'late' ? 'late' : 'absent';
    for (const roster of rosters) {
      // A real request: "if someone is manually marked absent after
      // checking in it should mark them absent everywhere." This used
      // to skip a roster entirely once its attendance row already read
      // 'present' - meant to protect a real same-day check-in from
      // being "yanked" by a stale/mistaken form, but it also silently
      // dropped the submission outright: no attendance row ever
      // actually flipped to absent/late, so it never showed up as
      // absent anywhere that reads live attendance (Setup/Cleanup's
      // absentMemberIdsForDate, the Floater board), and - since the
      // absence_submissions insert below sat on the same, now-skipped
      // code path - it never even reached the Attendance page's own
      // Alerts box or the Home dashboard's Alert Log (utils/alerts.js's
      // absenceFormAlertsForDay/absenceFormSubmissionsForRoster, both
      // read a live attendance row with source = 'absence_form'). A
      // manually-submitted absence/late now always overrides whatever
      // the live attendance row currently says, present or not.
      const existing = await db
        .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
        .get(student.id, roster.id, sessionDate);

      if (existing) {
        await db
          .prepare(`UPDATE attendance SET status = ?, source = 'absence_form', reason_category = ?, reason_text = ?, recorded_at = now_text() WHERE id = ?`)
          .run(status, reasonCategory, reason, existing.id);
      } else {
        await db
          .prepare(
            `INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category, reason_text)
             VALUES (?, ?, ?, ?, 'absence_form', ?, ?)`
          )
          .run(student.id, roster.id, sessionDate, status, reasonCategory, reason);
      }

      // A separate, append-only record of this submission - see the
      // absence_submissions migration's own comment. Unlike the
      // attendance row just written above, this one is never touched
      // again (in particular, never overwritten if the member later
      // checks in for real), so admin-logs.js's Absence/Late tab can
      // still show it happened even after that.
      await db
        .prepare(
          `INSERT INTO absence_submissions (member_id, roster_id, session_date, status, reason_category, reason_text)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(student.id, roster.id, sessionDate, status, reasonCategory, reason);
    }

    // A real request: "if someone submits an absence form and they are
    // currently assigned as a floater, it should automatically unassign
    // them... [and] unassign them to their floater positions" even
    // after already checking in, "including setup/cleanup."
    await unassignMemberForDate(sessionDate, student.id);
    await unassignMemberTasksForDate(sessionDate, student.id);

    namesRecorded.push(student.name);
  }

  if (namesRecorded.length === 0) {
    return fail(`None of the selected students are on a roster meeting on ${formatDateLabel(sessionDate)}.`);
  }

  const label = type === 'late' ? 'Late notice' : 'Absence';
  const message = `${label} recorded for ${namesRecorded.join(', ')} on ${formatDateLabel(sessionDate)}.`;

  res.render('absence', {
    title: 'Absence/Late Form',
    parents,
    childrenByParent,
    formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
    // redirectHome only actually fires the auto-navigate-to-/kiosk
    // behavior when fromKiosk is also true (views/absence.ejs's own
    // data-redirect-home) - a standalone Quick Link submission just
    // leaves the success message showing instead.
    result: { ok: true, message, redirectHome: true },
    fromKiosk,
  });
});

module.exports = router;
