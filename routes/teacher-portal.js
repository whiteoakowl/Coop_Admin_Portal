// Teacher Portal - view-only access to the classes a member is staffed on
// (class_staff, the EXISTING teacher/assistant model routes/admin-schedule.js
// already uses), plus each class's roster. Reuses utils/classSchedule.js's
// allClassesList for the same computed fields (timeLabel, gradeLabel,
// teacherNames) the Parent Portal's own Classes tab already relies on,
// rather than re-deriving day/time formatting a second time.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { allClassesList } = require('../utils/classSchedule');
const { assignmentsForClass, getAssignment, createAssignment, gradebookForAssignment, saveGrade } = require('../utils/academics');
const { formatDateLabel } = require('../utils/dates');

router.use(requirePortalAuth, requirePortal('teacher'));

// Every class this teacher is staffed on (teacher or assistant role) -
// re-derived from class_staff on every request rather than trusted from
// the request, the same "never trust a class id belongs to this account"
// rule Parent Portal's own childrenForAccount follows for students.
async function classesForTeacher(member) {
  if (!member) return [];
  const staffRows = await db.prepare('SELECT class_id, role FROM class_staff WHERE member_id = ?').all(member.id);
  const classIds = new Set(staffRows.map((r) => r.class_id));
  if (classIds.size === 0) return [];
  const all = await allClassesList(null);
  return all.filter((c) => classIds.has(c.id));
}

router.get('/', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  res.render('teacher-home', { title: 'Teacher Portal', member, classes });
});

router.get('/classes/:id', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const cls = classes.find((c) => c.id === parseInt(req.params.id, 10));
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher', backLabel: 'Back to Teacher Portal' });
  }
  const students = await db
    .prepare(`SELECT m.* FROM class_enrollments ce JOIN members m ON m.id = ce.student_id WHERE ce.class_id = ? ORDER BY LOWER(m.name)`)
    .all(cls.id);
  const assignments = (await assignmentsForClass(cls.id)).map((a) => ({ ...a, dueDateLabel: a.due_date ? formatDateLabel(a.due_date) : null }));
  res.render('teacher-roster', { title: cls.class_name, cls, students, assignments, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/classes/:id/assignments', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const cls = classes.find((c) => c.id === parseInt(req.params.id, 10));
  const back = `/teacher/classes/${req.params.id}`;
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher', backLabel: 'Back to Teacher Portal' });
  }
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(back + '?error=' + encodeURIComponent('An assignment title is required.'));
  await createAssignment({
    classId: cls.id,
    className: cls.class_name,
    title,
    description: (req.body.description || '').trim(),
    dueDate: req.body.dueDate || null,
    pointsPossible: req.body.pointsPossible ? parseInt(req.body.pointsPossible, 10) : null,
    createdByAccountId: req.portalAccount.id,
  });
  res.redirect(back + '?notice=' + encodeURIComponent(`"${title}" added.`));
});

router.get('/assignments/:id', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const assignment = await getAssignment(parseInt(req.params.id, 10));
  const cls = assignment ? classes.find((c) => c.id === assignment.class_id) : null;
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher', backLabel: 'Back to Teacher Portal' });
  }
  const { rows } = await gradebookForAssignment(assignment.id);
  res.render('teacher-gradebook', { title: assignment.title, cls, assignment, rows, notice: req.query.notice || null });
});

router.post('/assignments/:id/grades', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const assignmentId = parseInt(req.params.id, 10);
  const assignment = await getAssignment(assignmentId);
  const cls = assignment ? classes.find((c) => c.id === assignment.class_id) : null;
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher', backLabel: 'Back to Teacher Portal' });
  }

  const { rows } = await gradebookForAssignment(assignmentId);
  for (const row of rows) {
    const rawPoints = req.body[`points_${row.student_id}`];
    const pointsEarned = rawPoints === '' || rawPoints == null ? null : Number(rawPoints);
    const feedback = (req.body[`feedback_${row.student_id}`] || '').trim();
    await saveGrade({ assignmentId, studentId: row.student_id, pointsEarned, feedback, gradedByAccountId: req.portalAccount.id });
  }
  res.redirect(`/teacher/assignments/${assignmentId}?notice=` + encodeURIComponent('Grades saved.'));
});

module.exports = router;
