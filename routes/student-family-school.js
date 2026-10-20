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
const { todayISO, isValidISODate, addDays, formatDateLabel } = require('../utils/dates');
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
  mondayOf,
  weeklyPlanGrid,
} = require('../utils/familySchool');

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

router.get('/family-school/weekly-planner', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const weekStartDate = mondayOf(isValidISODate(req.query.week) ? req.query.week : todayISO());
  res.render('student-family-school-weekly-planner', {
    title: 'Weekly Planner',
    weeklyGrid: await weeklyPlanGrid(member.id, weekStartDate),
    weekStartLabel: formatDateLabel(weekStartDate),
    prevWeek: addDays(weekStartDate, -7),
    nextWeek: addDays(weekStartDate, 7),
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
  await submitAssignment({ contentItemId: found.contentItem.id, studentId: found.member.id, fileUrl: fileKey, fileName: req.file.originalname });
  res.redirect(`/student/family-school/classes/${found.cls.id}?notice=` + encodeURIComponent('Assignment submitted.'));
});

module.exports = router;
