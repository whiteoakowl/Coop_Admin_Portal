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
  res.render('teacher-roster', { title: cls.class_name, cls, students });
});

module.exports = router;
