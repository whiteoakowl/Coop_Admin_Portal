// Parent Portal - the first fully-built new member-facing portal. Reuses
// the EXISTING classes/class_enrollments domain model (utils/
// classSchedule.js) rather than a parallel "course" system; the only new
// tables are class_registrations (an audit trail of a parent's own
// registration actions) and the capacity/registration_open/description
// columns classes itself gained (see the portal-platform-foundation
// migration).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { allClassesList } = require('../utils/classSchedule');
const { formatFriendlyTimestamp, formatTimestamp } = require('../utils/dates');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { familyOf } = require('../utils/members');
const { libraryActivityForMemberIds } = require('../utils/library');
const { assignmentsForStudent, diplomaForStudent, transcriptForStudent } = require('../utils/academics');

router.use(requirePortalAuth, requirePortal('parent'));

// Every student in the signed-in parent's own family - the only students
// this portal ever lets them register/view, enforced here (not just
// hidden in the UI) by every route below re-deriving this same list
// rather than trusting a student id from the request.
async function childrenForAccount(account) {
  const member = await memberForAccount(account.id);
  if (!member || !member.family_id) return [];
  return db
    .prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'student' AND active = 1 ORDER BY LOWER(name)")
    .all(member.family_id);
}

router.get('/', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const announcementRows = await db
    .prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 5")
    .all();
  const announcements = announcementRows.map((a) => ({ ...a, publishedLabel: formatFriendlyTimestamp(a.published_at) }));

  const childIds = children.map((c) => c.id);
  const registrationCount = childIds.length
    ? Number(
        (
          await db
            .prepare(`SELECT COUNT(*) AS c FROM class_registrations WHERE status = 'confirmed' AND student_id IN (${childIds.map(() => '?').join(',')})`)
            .get(...childIds)
        ).c
      )
    : 0;

  res.render('parent-home', {
    title: 'Parent Portal',
    member: await memberForAccount(req.portalAccount.id),
    children,
    announcements,
    registrationCount,
  });
});

router.get('/classes', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const childIds = children.map((c) => c.id);
  const enrollmentRows = childIds.length
    ? await db
        .prepare(`SELECT class_id, student_id FROM class_enrollments WHERE student_id IN (${childIds.map(() => '?').join(',')})`)
        .all(...childIds)
    : [];
  const enrolledKey = new Set(enrollmentRows.map((r) => `${r.class_id}:${r.student_id}`));

  const classes = (await allClassesList(null)).map((c) => ({
    ...c,
    seatsLeft: c.capacity == null ? null : Math.max(0, c.capacity - Number(c.studentCount)),
    isFull: c.capacity != null && Number(c.studentCount) >= c.capacity,
  }));

  const windowOpen = await isRegistrationOpenForAccount(req.portalRoles);
  const nextWindow = windowOpen ? null : await nextWindowForAccount(req.portalRoles);

  res.render('parent-classes', {
    title: 'Classes',
    classes,
    children,
    enrolledKey: [...enrolledKey],
    windowOpen,
    nextWindowLabel: nextWindow ? formatTimestamp(nextWindow.opens_at) : null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/classes/:id/register', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = '/parent/classes';

  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === studentId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only register your own children.'));
  }
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.registration_open) {
    return res.redirect(back + '?error=' + encodeURIComponent('Registration is not open for that class.'));
  }
  if (!(await isRegistrationOpenForAccount(req.portalRoles))) {
    return res.redirect(back + '?error=' + encodeURIComponent('Registration is not open for your account yet.'));
  }
  const alreadyEnrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(classId, studentId);
  if (alreadyEnrolled) {
    return res.redirect(back + '?error=' + encodeURIComponent('Already registered for that class.'));
  }

  const enrolledCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?').get(classId)).c);
  const isFull = cls.capacity != null && enrolledCount >= cls.capacity;
  const status = isFull ? 'waitlisted' : 'confirmed';

  await db.withTransaction(async (tx) => {
    await tx
      .prepare('INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, ?)')
      .run(classId, studentId, req.portalAccount.id, status);
    if (status === 'confirmed') {
      await tx.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(classId, studentId);
    }
  });

  const student = children.find((c) => c.id === studentId);
  const notice = status === 'confirmed' ? `${student.name} is registered for "${cls.class_name}".` : `${cls.class_name} is full - ${student.name} has been added to the waitlist.`;
  res.redirect(back + '?notice=' + encodeURIComponent(notice));
});

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = '/parent/classes';

  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === studentId)) {
    return res.redirect(back + '?error=' + encodeURIComponent('You can only manage registrations for your own children.'));
  }

  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM class_enrollments WHERE class_id = ? AND student_id = ?').run(classId, studentId);
    await tx
      .prepare("UPDATE class_registrations SET status = 'cancelled', cancelled_at = now_text() WHERE class_id = ? AND student_id = ? AND status = 'confirmed'")
      .run(classId, studentId);
  });

  res.redirect(back + '?notice=' + encodeURIComponent('Registration cancelled.'));
});

// Library - read-only. Reuses the EXISTING library_items/library_checkouts
// tables the Co-op Admin Portal's own scan-based Library tools already
// write to; a parent just gets a filtered view of their own family's
// activity, not a second checkout system.
router.get('/library', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const family = member ? [member, ...(await familyOf(member.id))] : [];
  const memberIds = family.map((m) => m.id);
  const { active, recentReturns } = await libraryActivityForMemberIds(memberIds);
  res.render('parent-library', { title: 'Library', active, recentReturns });
});

// Academics - assignments/grades, transcript, and diploma status for each
// of the parent's own children in one place (utils/academics.js). Purely
// read-only, same as everywhere else a parent views (rather than acts on)
// their children's records.
router.get('/academics', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const academics = [];
  for (const child of children) {
    const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(child.id);
    const classIds = enrolledRows.map((r) => r.class_id);
    const assignments = await assignmentsForStudent(child.id, classIds);
    const { current, history } = await transcriptForStudent(child.id);
    const diploma = await diplomaForStudent(child.id);
    academics.push({ child, assignments, current, history, diploma });
  }
  res.render('parent-academics', { title: 'Academics', academics });
});

module.exports = router;
