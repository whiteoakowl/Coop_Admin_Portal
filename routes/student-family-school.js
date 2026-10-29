// Family School Management (Student Portal side) - a real request:
// "These classes will then appear under the students portal to work ok
// and complete." Read-only (plus Mark Complete/Upload actions) - every
// route here re-derives the signed-in student's own assigned classes
// from scratch before trusting any class/content item id in the URL,
// same rule routes/student-portal.js's own content routes already
// document. See utils/familySchool.js's own header comment for the
// schema/scope rationale (no quiz type, no lesson locking).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { lessonAttachmentFileFilter } = require('../utils/uploads');
const { formatDateLabel } = require('../utils/dates');
const { avatarColorFor } = require('../utils/members');
const {
  classesForStudent,
  lessonsForStudentView,
  getContentItem,
  getLesson,
  nextContentItemAfter,
  markLessonItemComplete,
  submitAssignment,
  saveAttachment,
  overviewForFamily,
  gradesForStudent,
  weeksForOwner,
  weekGrid,
  subjectBreakdownForGrid,
  attendanceForSchoolYear,
  currentSchoolYear,
  portfolioForStudent,
} = require('../utils/familySchool');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

router.use(requirePortalAuth, requirePortal('student'));

router.get('/family-school', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  res.render('student-family-school-classes', {
    title: 'Family School Management',
    classes: await classesForStudent(member.id),
  });
});

// A real request: "Student portal add a tab that says family
// homeschooling. Subpages are, homeschool overview, homeschool classes,
// homeschool grades, weekly planner." Read-only - reuses the exact same
// functions Parent Portal's own identical pages use (utils/
// familySchool.js), just always scoped to the signed-in student's own
// id/family, never a posted/query id, same rule this file's own header
// comment already states for every route here.
router.get('/family-school/overview', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const overview = member.family_id ? await overviewForFamily(member.family_id) : [];
  const own = overview.find((s) => s.id === member.id) || null;
  res.render('student-family-school-overview', { title: 'Homeschool Overview', student: own });
});

router.get('/family-school/grades', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  res.render('student-family-school-grades', { title: 'Homeschool Grades', grades: await gradesForStudent(member.id) });
});

// A real request: "Classroom dashboard subpages. Classes, grades,
// attendance, chat, portfolio, transcripts." Read-only, current school
// year only - the colored present/absent calendar Parent Portal's own
// identical page shows, minus the click-to-toggle and Filter/Export/
// Print/PDF controls (a parent marks attendance; a student just looks
// at it), same simplification this file's own Grades/Overview pages
// above already apply to their own Parent Portal counterparts.
router.get('/family-school/attendance', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const schoolYear = currentSchoolYear();
  const months = await attendanceForSchoolYear(member.id, parseInt(schoolYear.slice(0, 4), 10));
  res.render('student-family-school-attendance', { title: 'Attendance', schoolYear, MONTH_NAMES, months });
});

// Same "summarize all family school management features... visual
// profile" page Parent Portal's own Portfolio gives a parent, scoped to
// just the signed-in student (no student/school-year picker - there's
// only ever one student and this file's own convention is "all-time,
// no filter" for Overview/Grades too) and reusing that exact same
// partials/family-school-portfolio-body.ejs so the two never drift.
router.get('/family-school/portfolio', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const portfolio = await portfolioForStudent(member.id, null);
  res.render('student-family-school-portfolio', { title: 'Portfolio', portfolio, avatarColorFor });
});

// Read-only, same as every other route in this file - a student sees
// their own weeks (owner_type='student', this student's own id) and
// every Whole Family week (owner_type='family'), but never a "Parent"
// week (routes/parent-family-school.js's own 'parent' owner type) -
// that's a parent's own personal planning, not something to show a
// student. Picking a week shows its grid; nothing here can add,
// delete, or print one of those - only the parent who created it can.
router.get('/family-school/weekly-planner', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const ownWeeks = await weeksForOwner(member.family_id, 'student', member.id);
  const familyWeeks = await weeksForOwner(member.family_id, 'family', null);
  const weeks = [...ownWeeks, ...familyWeeks];
  const selectedWeekId = req.query.weekId ? parseInt(req.query.weekId, 10) : null;
  const selectedWeek = selectedWeekId ? weeks.find((w) => w.id === selectedWeekId) : null;
  let grid = null;
  let subjectBreakdown = null;
  if (selectedWeek) {
    grid = await weekGrid(selectedWeek.id);
    grid.forEach((d) => { d.dateLabel = formatDateLabel(d.date); });
    subjectBreakdown = subjectBreakdownForGrid(grid);
  }
  res.render('student-family-school-weekly-planner', {
    title: 'Weekly Planner',
    weeks,
    selectedWeek,
    grid,
    subjectBreakdown,
  });
});

router.get('/family-school/classes/:id', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classId = parseInt(req.params.id, 10);
  const classes = await classesForStudent(member.id);
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  res.render('student-family-school-class', {
    title: cls.class_name,
    cls,
    lessons: await lessonsForStudentView(cls.id, member.id),
  });
});

router.get('/family-school/content/:id', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const contentItemId = parseInt(req.params.id, 10);
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem) return res.status(404).render('404', { title: 'Not Found' });
  const lesson404 = await getLesson(contentItem.lesson_id);
  const classes = await classesForStudent(member.id);
  const cls = lesson404 ? classes.find((c) => c.id === lesson404.class_id) : null;
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });
  const lessons = await lessonsForStudentView(cls.id, member.id);
  const lesson = lessons.find((l) => l.id === lesson404.id);
  const item = lesson ? lesson.contentItems.find((i) => i.id === contentItemId) : null;
  if (!lesson || !item) return res.status(404).render('404', { title: 'Not Found' });
  const nextItem = nextContentItemAfter(lessons, item.id);
  const nextItemHref = nextItem ? `/student/family-school/content/${nextItem.id}` : null;
  res.render('student-family-school-content', { title: item.title || 'Assignment', cls, lesson, item, nextItemHref });
});

async function ownContentItem(req, contentItemId) {
  const member = await memberForAccount(req.portalAccount.id);
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem) return null;
  const lesson = await getLesson(contentItem.lesson_id);
  const classes = await classesForStudent(member.id);
  const cls = lesson ? classes.find((c) => c.id === lesson.class_id) : null;
  if (!cls) return null;
  return { member, contentItem, lesson, cls };
}

router.post('/family-school/content/:id/complete', async (req, res) => {
  const found = await ownContentItem(req, parseInt(req.params.id, 10));
  if (!found || found.contentItem.type === 'assignment_submission') return res.status(404).render('404', { title: 'Not Found' });
  await markLessonItemComplete(found.contentItem.id, found.member.id);
  res.redirect(`/student/family-school/classes/${found.cls.id}`);
});

const MAX_SUBMISSION_BYTES = 10 * 1024 * 1024;
const uploadSubmission = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SUBMISSION_BYTES }, fileFilter: lessonAttachmentFileFilter });

router.post('/family-school/content/:id/submit', uploadSubmission.single('submissionFile'), async (req, res) => {
  const found = await ownContentItem(req, parseInt(req.params.id, 10));
  if (!found || found.contentItem.type !== 'assignment_submission') return res.status(404).render('404', { title: 'Not Found' });
  if (!req.file) return res.redirect(`/student/family-school/classes/${found.cls.id}?error=` + encodeURIComponent('Choose a file to upload.'));
  const fileKey = await saveAttachment(req.file);
  await submitAssignment({ contentItemId: found.contentItem.id, studentId: found.member.id, fileUrl: fileKey, fileName: req.file.originalname, fileMime: req.file.mimetype });
  res.redirect(`/student/family-school/classes/${found.cls.id}?notice=` + encodeURIComponent('Assignment submitted.'));
});

module.exports = router;
