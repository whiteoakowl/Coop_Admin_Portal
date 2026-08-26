// Student Portal - mostly a read-only view of the signed-in student's own
// class schedule/assignments/transcript. Registration was originally a
// Parent-Portal-only action (a parent registers their children); a real
// request extended this so a student can register themselves too, but
// ONLY for a class that has its own allow_student_register turned on
// (off by default - see the class_registration_rules migration's own
// comment: "teachers and class assistants will be able to register, but
// not the students until allowed"). Shares the exact same registration
// logic Parent Portal uses (utils/classRegistration.js), just gated by
// allow_student_register instead of allow_parent_register.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { allClassesList } = require('../utils/classSchedule');
const { formatFriendlyTimestamp, formatTimestamp } = require('../utils/dates');
const { assignmentsForStudent, diplomaForStudent, transcriptForStudent } = require('../utils/academics');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('../utils/sections');
const { registerForClass, unregisterFromClass } = require('../utils/classRegistration');

router.use(requirePortalAuth, requirePortal('student'));

// Every class this student is enrolled in - re-derived from
// class_enrollments on every request, the same "never trust a class id
// belongs to this account" rule Parent/Teacher Portal both follow.
async function classesForStudent(member) {
  if (!member) return [];
  const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(member.id);
  const classIds = new Set(enrolledRows.map((r) => r.class_id));
  if (classIds.size === 0) return [];
  const all = await allClassesList(null);
  return all.filter((c) => classIds.has(c.id));
}

router.get('/', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const announcementRows = await db
    .prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 5")
    .all();
  const announcements = announcementRows.map((a) => ({ ...a, publishedLabel: formatFriendlyTimestamp(a.published_at) }));
  res.render('student-home', { title: 'Student Portal', member, classes, announcements });
});

router.get('/classes', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const enrolledIds = new Set(classes.map((c) => c.id));

  // Every OTHER class with self-registration turned on - "Register for a
  // Class" only ever shows classes not already in "My Classes" above, and
  // only ones a Main/Co-op Admin has actually opened to students (most
  // classes stay parent-registers-on-your-behalf, unaffected by any of
  // this - allow_student_register defaults off).
  const openClasses = member
    ? (await allClassesList(null))
        .filter((c) => c.allow_student_register && !enrolledIds.has(c.id))
        .map((c) => ({ ...c, seatsLeft: c.capacity == null ? null : Math.max(0, c.capacity - Number(c.studentCount)), isFull: c.capacity != null && Number(c.studentCount) >= c.capacity }))
    : [];
  const eligibleClassIds = [];
  if (member) {
    const mySectionIds = await sectionIdsForMember(member.id);
    for (const c of openClasses) {
      const restriction = await classSectionIds(c.id);
      if (memberSatisfiesRestriction(mySectionIds, restriction)) eligibleClassIds.push(c.id);
    }
  }

  const waitlistRows = member
    ? await db.prepare("SELECT class_id, waitlist_position FROM class_registrations WHERE student_id = ? AND status = 'waitlisted'").all(member.id)
    : [];
  const waitlistPositionByClassId = {};
  waitlistRows.forEach((r) => {
    waitlistPositionByClassId[r.class_id] = r.waitlist_position;
  });

  const windowOpen = await isRegistrationOpenForAccount(req.portalRoles);
  const nextWindow = windowOpen ? null : await nextWindowForAccount(req.portalRoles);

  res.render('student-classes', {
    title: 'My Classes',
    classes,
    openClasses,
    eligibleClassIds,
    waitlistPositionByClassId,
    windowOpen,
    nextWindowLabel: nextWindow ? formatTimestamp(nextWindow.opens_at) : null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/classes/:id/register', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = '/student/classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No student profile found for your account.'));

  const result = await registerForClass({
    classId,
    studentId: member.id,
    accountId: req.portalAccount.id,
    portalRoles: req.portalRoles,
    allowField: 'allow_student_register',
  });
  if (!result.ok) return res.redirect(back + '?error=' + encodeURIComponent(result.error));
  res.redirect(back + '?notice=' + encodeURIComponent(result.notice));
});

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = '/student/classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No student profile found for your account.'));

  const result = await unregisterFromClass({ classId, studentId: member.id, accountId: req.portalAccount.id });
  if (!result.ok) return res.redirect(back + '?error=' + encodeURIComponent(result.error));
  res.redirect(back + '?notice=' + encodeURIComponent('Registration cancelled.'));
});

router.get('/assignments', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const assignments = member ? await assignmentsForStudent(member.id, classes.map((c) => c.id)) : [];
  res.render('student-assignments', { title: 'Assignments', assignments });
});

router.get('/transcript', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const { current, history } = member ? await transcriptForStudent(member.id) : { current: [], history: [] };
  res.render('student-transcript', { title: 'Transcript', member, current, history });
});

router.get('/diploma', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const diploma = member ? await diplomaForStudent(member.id) : null;
  res.render('student-diploma', { title: 'Diploma', member, diploma });
});

module.exports = router;
