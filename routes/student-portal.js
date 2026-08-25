// Student Portal - a read-only view of the signed-in student's own class
// schedule. Registration itself stays a Parent Portal action (a parent
// registers their children - see routes/parent-portal.js); this portal
// only ever shows what the student is already enrolled in via the
// EXISTING class_enrollments table, never a second enrollment path.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { allClassesList } = require('../utils/classSchedule');
const { formatFriendlyTimestamp } = require('../utils/dates');

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
  res.render('student-classes', { title: 'My Classes', classes });
});

module.exports = router;
