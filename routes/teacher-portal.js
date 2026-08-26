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
const { formatDateLabel, formatFriendlyTimestamp, todayISO, formatDateLong } = require('../utils/dates');
const { byLastName } = require('../utils/members');
const { buildRosterGridData } = require('../utils/rosterGrid');
const notifications = require('../utils/notifications');

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

// Announcements on the homepage - same site-wide + per-account
// 'announcement' notification pattern Parent Portal's own home route
// established (routes/parent-portal.js), reused as-is here since a
// personal announcement is already filtered to the right audience at
// send time (Main/Co-op Admin's own role-targeted "Send to" dropdown -
// see routes/main-admin-announcements.js/routes/admin-announcements.js).
async function announcementsForAccount(accountId) {
  const siteRows = await db
    .prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 10")
    .all();
  const personalRows = await notifications.listForAccount(accountId, { typeKey: 'announcement' });
  return [
    ...siteRows.map((a) => ({ title: a.title, body: a.body, dateLabel: formatFriendlyTimestamp(a.published_at), sortKey: a.published_at, isNew: false })),
    ...personalRows.map((n) => ({ title: n.title, body: n.body, dateLabel: formatFriendlyTimestamp(n.created_at), sortKey: n.created_at, isNew: !n.read_at })),
  ]
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
    .slice(0, 15);
}

router.get('/', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const announcements = await announcementsForAccount(req.portalAccount.id);
  res.render('teacher-home', { title: 'Teacher Portal', member, classes, announcements });
});

// "Classes" tab - the same per-class cards the homepage used to show,
// now its own page so Home can lead with Announcements instead (a real
// request: teacher/student portal both get an explicit Classes tab,
// separate from Home).
router.get('/classes', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  res.render('teacher-classes', { title: 'My Classes', classes });
});

// Self-signup as a teacher or assistant on a class - a real request:
// "teachers and class assistants will be able to register" for a class
// themselves (unlike students, this defaults ON - allow_teacher_register
// is true unless a Main/Co-op Admin turns it off for a specific class),
// capped by that class's own teacher_slots/assistant_slots (null means
// unlimited). Writes directly to class_staff, the EXISTING teacher/
// assistant model routes/admin-schedule.js already uses for admin-
// assigned staff - self-signup and admin-assignment are the same table,
// just two different ways a row gets added.
async function staffCountsForClass(classId) {
  const rows = await db.prepare('SELECT role, COUNT(*) AS c FROM class_staff WHERE class_id = ? GROUP BY role').all(classId);
  const counts = { teacher: 0, assistant: 0 };
  rows.forEach((r) => {
    counts[r.role] = Number(r.c);
  });
  return counts;
}

router.get('/browse-classes', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const myClasses = await classesForTeacher(member);
  const myClassIds = new Set(myClasses.map((c) => c.id));

  const openClasses = (await allClassesList(null)).filter((c) => c.allow_teacher_register && !myClassIds.has(c.id));
  const countsByClass = {};
  for (const c of openClasses) countsByClass[c.id] = await staffCountsForClass(c.id);

  res.render('teacher-browse-classes', {
    title: 'Sign Up to Teach',
    openClasses,
    myClasses,
    countsByClass,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/classes/:id/join', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  const back = '/teacher/browse-classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No profile found for your account.'));

  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.allow_teacher_register) {
    return res.redirect(back + '?error=' + encodeURIComponent('Self-signup is not open for that class.'));
  }
  const already = await db.prepare('SELECT 1 FROM class_staff WHERE class_id = ? AND member_id = ?').get(classId, member.id);
  if (already) return res.redirect(back + '?error=' + encodeURIComponent('You are already staffed on that class.'));

  const counts = await staffCountsForClass(classId);
  const slots = role === 'teacher' ? cls.teacher_slots : cls.assistant_slots;
  if (slots != null && counts[role] >= slots) {
    return res.redirect(back + '?error=' + encodeURIComponent(`That class already has its full ${slots} ${role}(s).`));
  }

  await db.prepare('INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)').run(classId, member.id, role);
  res.redirect(back + '?notice=' + encodeURIComponent(`Signed up as ${role} for "${cls.class_name}".`));
});

router.post('/classes/:id/leave', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = '/teacher/browse-classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No profile found for your account.'));

  await db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(classId, member.id);
  res.redirect(back + '?notice=' + encodeURIComponent('Removed from that class.'));
});

router.get('/classes/:id', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const cls = classes.find((c) => c.id === parseInt(req.params.id, 10));
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher', backLabel: 'Back to Teacher Portal' });
  }
  const students = (
    await db.prepare(`SELECT m.* FROM class_enrollments ce JOIN members m ON m.id = ce.student_id WHERE ce.class_id = ?`).all(cls.id)
  ).sort(byLastName);
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

// --- Attendance tab ---
// A real request: teacher portal gets its own Attendance tab. Reuses the
// exact same buildRosterGridData/attendance-grid.js auto-save pattern the
// kiosk Class Check-In attendance screen already established
// (routes/kiosk-class-checkin.js) - a teacher marking their own class's
// attendance for today is the same trust level as a staff member running
// that class at the kiosk, just reached through the portal instead.

router.get('/attendance', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  res.render('teacher-attendance', { title: 'Attendance', classes });
});

router.get('/classes/:id/attendance', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const cls = classes.find((c) => c.id === parseInt(req.params.id, 10));
  if (!cls) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't teach that class.", backHref: '/teacher/attendance', backLabel: 'Back to Attendance' });
  }
  if (!cls.roster_id) {
    return res.render('teacher-class-attendance', { title: `${cls.class_name} Attendance`, cls, dateLabel: formatDateLong(todayISO()), rows: [], summary: { present: 0, late: 0, absent: 0 } });
  }
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(cls.roster_id);
  const today = todayISO();
  const grid = await buildRosterGridData(roster, [today]);
  res.render('teacher-class-attendance', {
    title: `${cls.class_name} Attendance`,
    cls,
    dateLabel: formatDateLong(today),
    rows: grid.rows,
    summary: grid.summary[0] || { present: 0, late: 0, absent: 0 },
  });
});

// Same status:<memberId>:<date> body-key convention as every other
// attendance-grid.js consumer (admin-rosters.js, kiosk-class-checkin.js) -
// public/js/attendance-grid.js drives this endpoint unmodified, just
// pointed here via data-endpoint.
router.post('/classes/:id/attendance', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const cls = classes.find((c) => c.id === parseInt(req.params.id, 10));
  if (!cls || !cls.roster_id) return res.status(403).send('Not authorized');
  const roster = await db.prepare('SELECT * FROM rosters WHERE id = ?').get(cls.roster_id);
  if (!roster) return res.status(404).send('Not found');

  const upsert = db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, source)
     VALUES (?, ?, ?, ?, 'manual')
     ON CONFLICT(member_id, roster_id, session_date) DO UPDATE SET
       status = excluded.status,
       source = 'manual'`
  );
  const clear = db.prepare('DELETE FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?');

  for (const key of Object.keys(req.body)) {
    const match = /^status:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) continue;
    const [, memberId, date] = match;
    const value = (req.body[key] || '').trim();
    if (value === 'present' || value === 'late' || value === 'absent') {
      await upsert.run(parseInt(memberId, 10), roster.id, date, value);
    } else {
      await clear.run(parseInt(memberId, 10), roster.id, date);
    }
  }

  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect(`/teacher/classes/${cls.id}/attendance`);
});

// --- Assignments tab (across every class this teacher is staffed on) ---

router.get('/assignments', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const assignmentsByClass = [];
  for (const cls of classes) {
    const assignments = (await assignmentsForClass(cls.id)).map((a) => ({ ...a, dueDateLabel: a.due_date ? formatDateLabel(a.due_date) : null }));
    assignmentsByClass.push({ cls, assignments });
  }
  res.render('teacher-assignments', { title: 'Assignments', assignmentsByClass });
});

// --- Reports tab: a simple per-class grade summary ---

router.get('/reports', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForTeacher(member);
  const reports = [];
  for (const cls of classes) {
    const assignments = await assignmentsForClass(cls.id);
    const assignmentReports = [];
    for (const a of assignments) {
      const { rows } = await gradebookForAssignment(a.id);
      const graded = rows.filter((r) => r.points_earned != null);
      const avgPercent = graded.length && a.points_possible ? Math.round((graded.reduce((sum, r) => sum + Number(r.points_earned), 0) / graded.length / a.points_possible) * 100) : null;
      assignmentReports.push({ assignment: a, gradedCount: graded.length, totalCount: rows.length, avgPercent });
    }
    reports.push({ cls, assignmentReports });
  }
  res.render('teacher-reports', { title: 'Reports', reports });
});

module.exports = router;
