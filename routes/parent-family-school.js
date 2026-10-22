// Family School Management (Parent Portal side) - a real request:
// "Parent portal, student portal and main admin portal add a tab called
// family school management. Under this tab parent can create classed,
// lessons and assignments and assign these classes to their own students
// in their family. These classes will then appear under the students
// portal to work ok and complete. Parents can edit, track and view all
// of it. Subpage for grades, subapge for parent to take attendance by
// the date... Subpage for teacher journal... These classes are
// completely seperate from co-op classes and schedules as well as co-op
// teachers. It has nothing to do with that at all." See utils/
// familySchool.js's own header comment for the schema/scope rationale.
// Own router file (not folded into the already-large routes/parent-
// portal.js), same split-file convention routes/admin-lesson-plans.js
// already established for a similarly self-contained feature.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { avatarColorFor } = require('../utils/members');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const { lessonAttachmentFileFilter } = require('../utils/uploads');
const {
  CONTENT_ITEM_TYPES,
  classesForFamily,
  overviewForFamily,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  studentsForClass,
  assignClassToStudents,
  lessonsForClass,
  getLesson,
  createLesson,
  updateLesson,
  deleteLesson,
  reorderLessons,
  getContentItem,
  contentItemsForLesson,
  createContentItem,
  updateContentItem,
  deleteContentItem,
  reorderContentItems,
  saveAttachment,
  gradeAssignmentSubmission,
  gradesForStudent,
  attendanceForStudent,
  allAttendanceForStudent,
  attendanceForSchoolYear,
  toggleAttendance,
  familyAttendanceForMonth,
  familyAttendanceForSchoolYear,
  toggleFamilyAttendance,
  monthGridDays,
  journalEntriesForStudent,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  getJournalEntry,
  attachmentsForJournalEntry,
  getJournalAttachment,
  addJournalAttachment,
  deleteJournalAttachment,
  volunteerHoursForStudent,
  totalVolunteerHoursForStudent,
  createVolunteerHourEntry,
  getVolunteerHourEntry,
  deleteVolunteerHourEntry,
  currentSchoolYear,
  schoolYearOptions,
  curriculumForStudent,
  createCurriculumItem,
  getCurriculumItem,
  deleteCurriculumItem,
  weeksForOwner,
  getWeek,
  createWeek,
  deleteWeek,
  getWeekDate,
  weekGrid,
  weekDateRangeLabel,
  subjectBreakdownForGrid,
  createWeekAssignment,
  getWeekAssignment,
  deleteWeekAssignment,
  moveWeekAssignment,
  assignmentOptionsForFamily,
  portfolioForStudent,
} = require('../utils/familySchool');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { renderViewToPdf } = require('../utils/pdfRender');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - sends a headless-Chromium-rendered
// PDF of viewName (one of this router's own *-print.ejs views) instead
// of a CSV, under the same filename convention (now .pdf) the old
// download.csv route used.
function sendPdf(res, filename, pdfBuffer) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
}

// Journal entries are stored as sanitized HTML (the rich-text editor's
// own output) - plain text for a CSV cell, same inline strip-tags idiom
// utils/events.js/utils/globalSearch.js already use elsewhere.
function plainText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

router.use(requirePortalAuth, requirePortal('parent'));

// Every route below re-derives the signed-in parent's own family_id and
// re-checks that whatever class/lesson/content item/student id is in the
// URL actually belongs to THAT family, the same "never trust an id from
// the request alone" rule childrenForAccount (routes/parent-portal.js)
// already documents - a family can only ever see or touch its own Family
// School data.
async function familyIdForAccount(account) {
  const member = await memberForAccount(account.id);
  return member ? member.family_id : null;
}

async function studentsForFamily(familyId) {
  if (!familyId) return [];
  return db.prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'student' AND active = 1 ORDER BY name COLLATE \"C\"").all(familyId);
}

// Loads the class only if it belongs to this account's own family;
// null otherwise, so every route below can 404 uniformly.
async function requireOwnClass(req) {
  const familyId = await familyIdForAccount(req.portalAccount);
  const cls = await getClass(parseInt(req.params.id, 10));
  if (!cls || cls.family_id !== familyId) return null;
  return cls;
}

async function requireOwnLesson(req, lessonId) {
  const lesson = await getLesson(lessonId);
  if (!lesson) return null;
  const familyId = await familyIdForAccount(req.portalAccount);
  const cls = await getClass(lesson.class_id);
  if (!cls || cls.family_id !== familyId) return null;
  return { lesson, cls };
}

// A real request: "First subpage should be family school management.
// This page shows a card per kid. Each card shows the students name,
// grade level, list of family classes and their overall grade next to
// each class. Also over gpa based on current individual class grades...
// Each card also has the students profile picture from their profile.
// Each card also has a total count of attendance days from family
// management attendance per student. 1/180." The bare /family-school
// landing page is this overview dashboard now - overviewForFamily
// (utils/familySchool.js) does the per-student grade/GPA/attendance
// aggregation; the actual class list moved to its own /classes subpage
// below.
router.get('/family-school', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const students = await overviewForFamily(familyId);
  // The Filter popover's own student checkbox list - a real request:
  // "Make sure they are similar size, same height, fit to text" (for
  // the Export/Print/Download/Filter row) meant this page needed a
  // Filter control too, even though it has no existing per-student
  // selector the way Attendance/Grades/Journal do. Narrows which cards
  // render; an empty/missing selection means "show everyone" rather
  // than "show no one".
  const filterStudentIds = [].concat(req.query.studentId || []).map((v) => parseInt(v, 10));
  res.render('parent-family-school-overview', {
    title: 'Family School Management',
    students: filterStudentIds.length ? students.filter((s) => filterStudentIds.includes(s.id)) : students,
    allStudents: students,
    filterStudentIds,
    avatarColorFor,
  });
});

// Export/Print/Download/Filter buttons - a real request: "Add the
// following buttons to each page. Export, print, download, filter."
// Export is the summary one row per student (what the Overview cards
// themselves show); Download is the detailed one row per student per
// class breakdown - the same "current view vs. everything" split these
// buttons use on every Family School Management page below.
router.get('/family-school/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const students = await overviewForFamily(familyId);
  const lines = [
    toCsvRow(['Student', 'Grade Level', 'GPA', 'Attendance']),
    ...students.map((s) => toCsvRow([s.name, s.grade_level || '', s.gpa != null ? s.gpa.toFixed(2) : '', `${s.presentDays}/${s.attendanceTargetDays}`])),
  ];
  sendCsv(res, 'family-school-management.csv', lines);
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - every family student's own
// per-class breakdown, the same scope the old download.csv route
// used, now a PDF built from the exact same -print.ejs view the Print
// button opens.
router.get('/family-school/download.pdf', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const students = await overviewForFamily(familyId);
  const pdf = await renderViewToPdf(req, 'parent-family-school-overview-print', {
    title: 'Family School Management',
    mode: 'family',
    students,
  });
  sendPdf(res, 'family-school-management-detail.pdf', pdf);
});

// A real request: "All print button should show a print preview full
// real page on a page with a print button." Mirrors the live page's
// own (filtered) card grid, not the full unfiltered detail Download
// above covers.
router.get('/family-school/print', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const students = await overviewForFamily(familyId);
  const filterStudentIds = [].concat(req.query.studentId || []).map((v) => parseInt(v, 10));
  res.render('parent-family-school-overview-print', {
    title: 'Family School Management',
    mode: 'single',
    students: filterStudentIds.length ? students.filter((s) => filterStudentIds.includes(s.id)) : students,
    avatarColorFor,
  });
});

router.get('/family-school/classes', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  res.render('parent-family-school-classes', {
    title: 'Family Classes',
    classes: await classesForFamily(familyId),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/classes', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const className = (req.body.className || '').trim();
  if (!className) return res.redirect('/parent/family-school/classes?error=' + encodeURIComponent('A class name is required.'));
  const id = await createClass({ familyId, className, description: (req.body.description || '').trim(), createdByAccountId: req.portalAccount.id });
  res.redirect(`/parent/family-school/classes/${id}?notice=` + encodeURIComponent('Class created.'));
});

router.post('/family-school/classes/:id/delete', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  await deleteClass(cls.id);
  res.redirect('/parent/family-school/classes?notice=' + encodeURIComponent(`Deleted "${cls.class_name}".`));
});

router.get('/family-school/classes/:id', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  res.render('parent-family-school-class-manage', {
    title: cls.class_name,
    cls,
    lessons: await lessonsForClass(cls.id),
    familyStudents: await studentsForFamily(cls.family_id),
    assignedStudents: await studentsForClass(cls.id),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/classes/:id/edit', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  const className = (req.body.className || '').trim();
  if (!className) return res.redirect(`/parent/family-school/classes/${cls.id}?error=` + encodeURIComponent('A class name is required.'));
  await updateClass(cls.id, { className, description: (req.body.description || '').trim() });
  res.redirect(`/parent/family-school/classes/${cls.id}?notice=` + encodeURIComponent('Class updated.'));
});

router.post('/family-school/classes/:id/students', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  const familyStudentIds = (await studentsForFamily(cls.family_id)).map((s) => s.id);
  const requested = [].concat(req.body.studentIds || []).map((v) => parseInt(v, 10));
  // Only ever assigns students who actually belong to this family,
  // regardless of what ids a tampered request might include.
  const studentIds = requested.filter((id) => familyStudentIds.includes(id));
  await assignClassToStudents(cls.id, studentIds);
  res.redirect(`/parent/family-school/classes/${cls.id}?notice=` + encodeURIComponent('Students updated.'));
});

router.post('/family-school/classes/:id/lessons', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/parent/family-school/classes/${cls.id}?error=` + encodeURIComponent('A lesson title is required.'));
  const id = await createLesson({ classId: cls.id, title, description: (req.body.description || '').trim(), createdByAccountId: req.portalAccount.id });
  res.redirect(`/parent/family-school/lessons/${id}?notice=` + encodeURIComponent('Lesson created.'));
});

// public/js/lesson-drag-reorder.js (shared with the co-op's own lesson
// list) always posts its lesson-list body as { assignmentIds: [...] } -
// a holdover from "class_assignments IS lessons now" there, hardcoded in
// that shared script rather than customizable per caller.
router.post('/family-school/classes/:id/lessons/reorder', async (req, res) => {
  const cls = await requireOwnClass(req);
  if (!cls) return res.status(404).send('Not found');
  const lessonIds = [].concat(req.body.assignmentIds || []).map((v) => parseInt(v, 10));
  await reorderLessons(cls.id, lessonIds);
  res.json({ ok: true });
});

router.post('/family-school/lessons/:id/delete', async (req, res) => {
  const found = await requireOwnLesson(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).send('Not found');
  await deleteLesson(found.lesson.id);
  res.redirect(`/parent/family-school/classes/${found.cls.id}?notice=` + encodeURIComponent(`Deleted "${found.lesson.title}".`));
});

router.get('/family-school/lessons/:id', async (req, res) => {
  const found = await requireOwnLesson(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).send('Not found');
  res.render('parent-family-school-lesson-manage', {
    title: found.lesson.title,
    lesson: found.lesson,
    cls: found.cls,
    contentItems: await contentItemsForLesson(found.lesson.id),
    basePath: '/parent/family-school',
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/lessons/:id/edit', async (req, res) => {
  const found = await requireOwnLesson(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/parent/family-school/lessons/${found.lesson.id}?error=` + encodeURIComponent('A lesson title is required.'));
  await updateLesson(found.lesson.id, { title, description: (req.body.description || '').trim() });
  res.redirect(`/parent/family-school/lessons/${found.lesson.id}?notice=` + encodeURIComponent('Lesson updated.'));
});

// --- Content items (mirrors routes/admin-lesson-plans.js's own content
// routes field-for-field, minus quiz - see utils/familySchool.js's own
// header comment). ---

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES }, fileFilter: lessonAttachmentFileFilter });
function uploadAttachment(req, res, next) {
  attachmentUpload.single('attachment')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect(
        `/parent/family-school/lessons/${req.params.id}?error=` +
          encodeURIComponent(`That file is too large - attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB.`)
      );
    }
    next(err);
  });
}

router.post('/family-school/lessons/:id/content', uploadAttachment, async (req, res) => {
  const found = await requireOwnLesson(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).send('Not found');
  const back = `/parent/family-school/lessons/${found.lesson.id}`;
  const type = req.body.type;
  if (!CONTENT_ITEM_TYPES.includes(type)) return res.redirect(back + '?error=' + encodeURIComponent('Choose a content type.'));

  let attachmentKey = null;
  let attachmentName = null;
  if (type === 'assignment_upload' && req.file) {
    attachmentKey = await saveAttachment(req.file);
    attachmentName = req.file.originalname;
  }

  await createContentItem({
    lessonId: found.lesson.id,
    type,
    title: (req.body.title || '').trim(),
    videoUrl: type === 'video' ? (req.body.videoUrl || '').trim() : null,
    body:
      type === 'text'
        ? (req.body.body || '').trim()
        : type === 'assignment_upload'
        ? sanitizePostBody(req.body.assignmentBody || '')
        : type === 'assignment_submission'
        ? sanitizePostBody(req.body.submissionBody || '')
        : null,
    fileUrl: type === 'file' ? (req.body.fileUrl || '').trim() : null,
    description: type === 'video' ? (req.body.description || '').trim() : type === 'file' ? (req.body.fileDescription || '').trim() : null,
    attachmentUrl: attachmentKey,
    attachmentName,
    pointsPossible: type === 'assignment_submission' && req.body.submissionPointsPossible ? parseInt(req.body.submissionPointsPossible, 10) : null,
    dueDate: (req.body.contentDueDate || '').trim() || null,
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Added to the lesson.'));
});

async function requireOwnContentItem(req) {
  const contentItem = await getContentItem(parseInt(req.params.id, 10));
  if (!contentItem) return null;
  const familyId = await familyIdForAccount(req.portalAccount);
  const lesson = await getLesson(contentItem.lesson_id);
  const cls = lesson ? await getClass(lesson.class_id) : null;
  if (!cls || cls.family_id !== familyId) return null;
  return { contentItem, lesson, cls };
}

router.post('/family-school/content/:id/edit', uploadAttachment, async (req, res) => {
  const found = await requireOwnContentItem(req);
  if (!found) return res.status(404).send('Not found');
  const { contentItem } = found;
  const back = `/parent/family-school/lessons/${contentItem.lesson_id}`;
  const type = contentItem.type;

  let attachmentKey = contentItem.attachment_url;
  let attachmentName = contentItem.attachment_name;
  if (type === 'assignment_upload' && req.file) {
    attachmentKey = await saveAttachment(req.file);
    attachmentName = req.file.originalname;
  }

  await updateContentItem(contentItem.id, {
    title: (req.body.title || '').trim(),
    videoUrl: type === 'video' ? (req.body.videoUrl || '').trim() : contentItem.video_url,
    body:
      type === 'text'
        ? (req.body.body || '').trim()
        : type === 'assignment_upload'
        ? sanitizePostBody(req.body.assignmentBody || '')
        : type === 'assignment_submission'
        ? sanitizePostBody(req.body.submissionBody || '')
        : contentItem.body,
    fileUrl: type === 'file' ? (req.body.fileUrl || '').trim() : contentItem.file_url,
    description: type === 'video' ? (req.body.description || '').trim() : type === 'file' ? (req.body.fileDescription || '').trim() : contentItem.description,
    attachmentUrl: attachmentKey,
    attachmentName,
    pointsPossible: type === 'assignment_submission' && req.body.submissionPointsPossible ? parseInt(req.body.submissionPointsPossible, 10) : null,
    dueDate: (req.body.contentDueDate || '').trim() || null,
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Updated.'));
});

router.post('/family-school/content/:id/delete', async (req, res) => {
  const found = await requireOwnContentItem(req);
  if (!found) return res.status(404).send('Not found');
  await deleteContentItem(found.contentItem.id);
  res.redirect(`/parent/family-school/lessons/${found.contentItem.lesson_id}?notice=` + encodeURIComponent('Removed.'));
});

router.post('/family-school/lessons/:id/content/reorder', async (req, res) => {
  const found = await requireOwnLesson(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).json({ ok: false });
  const contentItemIds = [].concat(req.body.contentItemIds || []).map((v) => parseInt(v, 10));
  await reorderContentItems(found.lesson.id, contentItemIds);
  res.json({ ok: true });
});

// --- Grades subpage - a real request: "Subpage for grades." See utils/
// familySchool.js's own gradesForStudent comment: reads straight from
// each assignment_submission content item's own grade fields, no
// separate grades table. Grading itself (pointsEarned/gradeLetter/
// feedback) happens right here too - "parents can edit, track and view
// all of it" in one place, not a second page per assignment. ---

router.get('/family-school/grades', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const isOwnStudent = selectedStudentId && familyStudents.some((s) => s.id === selectedStudentId);
  res.render('parent-family-school-grades', {
    title: 'Family Grades',
    familyStudents,
    selectedStudentId: isOwnStudent ? selectedStudentId : null,
    grades: isOwnStudent ? await gradesForStudent(selectedStudentId) : [],
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/family-school/grades/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const grades = student ? await gradesForStudent(student.id) : [];
  const lines = [
    toCsvRow(['Student', 'Class', 'Lesson', 'Assignment', 'Due', 'Submitted', 'Points Earned', 'Points Possible', 'Grade Letter']),
    ...grades.map((g) =>
      toCsvRow([student.name, g.class_name, g.lesson_title, g.item_title || '', g.dueDateLabel || '', g.submission_id ? 'Yes' : 'No', g.points_earned != null ? g.points_earned : '', g.points_possible != null ? g.points_possible : '', g.grade_letter || ''])
    ),
  ];
  sendCsv(res, 'family-grades.csv', lines);
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - every family student's own grades,
// the same scope the old download.csv route used, now a PDF built from
// the exact same -print.ejs view the Print button opens.
router.get('/family-school/grades/download.pdf', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const familyRows = [];
  for (const student of familyStudents) familyRows.push({ student, grades: await gradesForStudent(student.id) });
  const pdf = await renderViewToPdf(req, 'parent-family-school-grades-print', {
    title: 'Family Grades',
    mode: 'family',
    familyRows,
  });
  sendPdf(res, 'family-grades-all.pdf', pdf);
});

// A real request: "All print button should show a print preview full
// real page on a page with a print button."
router.get('/family-school/grades/print', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  res.render('parent-family-school-grades-print', {
    title: 'Family Grades',
    mode: 'single',
    studentLabel: student ? student.name : '',
    grades: student ? await gradesForStudent(student.id) : [],
  });
});

router.post('/family-school/grades/:contentItemId/:studentId', async (req, res) => {
  const contentItemId = parseInt(req.params.contentItemId, 10);
  const studentId = parseInt(req.params.studentId, 10);
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  if (!familyStudents.some((s) => s.id === studentId)) return res.status(404).send('Not found');
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem) return res.status(404).send('Not found');
  const lesson = await getLesson(contentItem.lesson_id);
  const cls = lesson ? await getClass(lesson.class_id) : null;
  if (!cls || cls.family_id !== familyId) return res.status(404).send('Not found');

  await gradeAssignmentSubmission({
    contentItemId,
    studentId,
    pointsEarned: req.body.pointsEarned,
    gradeLetter: (req.body.gradeLetter || '').trim(),
    feedback: (req.body.feedback || '').trim(),
  });
  res.redirect(`/parent/family-school/grades?studentId=${studentId}&notice=` + encodeURIComponent('Grade saved.'));
});

// --- Attendance subpage - a real request: "subapge for parent to take
// attendance by the date. View a calendar and mark days student is
// present for school by clicking on the date and it highlights gren. If
// you click again it becomes red for didn't do school." ---

router.get('/family-school/attendance', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  // A real request: "attendance drop down to choose one of your
  // children or family. Can take attendance by individual child or
  // select family and take attendance that will appear on all
  // individual attendance calendars for each child/student." The
  // literal string "family" is checked before the existing parseInt
  // path below (parseInt('family', 10) is NaN, which would otherwise
  // silently fall through to "no student selected").
  const isFamilyMode = req.query.studentId === 'family';
  const selectedStudentId = isFamilyMode
    ? null
    : req.query.studentId
      ? parseInt(req.query.studentId, 10)
      : familyStudents[0]
        ? familyStudents[0].id
        : null;
  const isOwnStudent = selectedStudentId && familyStudents.some((s) => s.id === selectedStudentId);
  const now = new Date();
  const year = req.query.year ? parseInt(req.query.year, 10) : now.getUTCFullYear();
  const month = req.query.month ? parseInt(req.query.month, 10) : now.getUTCMonth() + 1;
  // A real request: "the month should be a drop down choice of months/
  // years." currentYear is always included in the range regardless of
  // which year is actually selected, so jumping to an old year (e.g. via
  // a bookmarked/shared link) never drops that year's own option out of
  // its own <select>.
  const currentYear = now.getUTCFullYear();
  const yearRangeStart = Math.min(year, currentYear - 2);
  const yearRangeEnd = Math.max(year, currentYear + 1);
  const yearOptions = [];
  for (let y = yearRangeStart; y <= yearRangeEnd; y++) yearOptions.push(y);
  let attendanceByDate = {};
  if (isFamilyMode) {
    attendanceByDate = await familyAttendanceForMonth(familyStudents.map((s) => s.id), year, month);
  } else if (isOwnStudent) {
    attendanceByDate = await attendanceForStudent(selectedStudentId, year, month);
  }
  res.render('parent-family-school-attendance', {
    title: 'Family Attendance',
    familyStudents,
    selectedStudentId: isOwnStudent ? selectedStudentId : null,
    isFamilyMode,
    year,
    month,
    yearOptions,
    weeks: monthGridDays(year, month),
    attendanceByDate,
  });
});

// A real request: "select family and take attendance that will appear
// on all individual attendance calendars for each child/student." -
// registered before the single-student toggle route below, since
// Express would otherwise match "family" as that route's own
// :studentId param.
router.post('/family-school/attendance/family/toggle', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  if (familyStudents.length === 0) return res.status(404).json({ ok: false });
  const date = (req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false });
  const status = await toggleFamilyAttendance(familyStudents.map((s) => s.id), date);
  res.json({ ok: true, status });
});

// AJAX endpoint (public/js/family-school-attendance.js) - cycles one
// date's own mark and reports back the new state so the calendar cell
// can recolor itself without a full page reload.
router.post('/family-school/attendance/:studentId/toggle', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  if (!familyStudents.some((s) => s.id === studentId)) return res.status(404).json({ ok: false });
  const date = (req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false });
  const status = await toggleAttendance(studentId, date);
  res.json({ ok: true, status });
});

router.get('/family-school/attendance/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  // "Whole Family" has no single student to export, so Export CSV
  // falls back to the same every-student rows Download CSV already
  // sends (below) rather than exporting nothing.
  if (req.query.studentId === 'family') {
    const lines = [toCsvRow(['Student', 'Date', 'Status'])];
    for (const student of familyStudents) {
      const rows = await allAttendanceForStudent(student.id);
      for (const r of rows) lines.push(toCsvRow([student.name, r.attendance_date, r.status]));
    }
    return sendCsv(res, 'family-attendance.csv', lines);
  }
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const rows = student ? await allAttendanceForStudent(student.id) : [];
  const lines = [toCsvRow(['Student', 'Date', 'Status']), ...rows.map((r) => toCsvRow([student.name, r.attendance_date, r.status]))];
  sendCsv(res, 'family-attendance.csv', lines);
});

// A real request: "Pdf and print should show all 12 months, August-
// July 2026-2027." Aug-Jul school year containing whatever month/year
// the live calendar currently has selected (so Print/Download always
// cover the school year the person was actually looking at); with
// neither given, the school year containing today.
function schoolYearStartFromQuery(req) {
  if (req.query.year && req.query.month) {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    return month >= 8 ? year : year - 1;
  }
  return parseInt(currentSchoolYear().split('-')[0], 10);
}

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - every family student's own full
// school year, the same Aug-Jul span the Print preview below covers,
// now a PDF built from the exact same -print.ejs view the Print button
// opens.
router.get('/family-school/attendance/download.pdf', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const schoolYearStart = schoolYearStartFromQuery(req);
  const familyRows = [];
  for (const student of familyStudents) familyRows.push({ student, months: await attendanceForSchoolYear(student.id, schoolYearStart) });
  const pdf = await renderViewToPdf(req, 'parent-family-school-attendance-print', {
    title: 'Family Attendance',
    mode: 'family',
    schoolYearLabel: `${schoolYearStart}-${schoolYearStart + 1}`,
    MONTH_NAMES,
    familyRows,
  });
  sendPdf(res, 'family-attendance-all.pdf', pdf);
});

// A real request: "All print button should show a print preview full
// real page on a page with a print button," later refined to: "Pdf and
// print should show all 12 months, August-July 2026-2027" - same
// student/family selection the live calendar shows, but every month of
// that selection's own school year, not just the one currently open.
router.get('/family-school/attendance/print', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const isFamilyMode = req.query.studentId === 'family';
  const selectedStudentId = isFamilyMode
    ? null
    : req.query.studentId
      ? parseInt(req.query.studentId, 10)
      : familyStudents[0]
        ? familyStudents[0].id
        : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const schoolYearStart = schoolYearStartFromQuery(req);
  let months = [];
  let studentLabel = '';
  if (isFamilyMode) {
    months = await familyAttendanceForSchoolYear(familyStudents.map((s) => s.id), schoolYearStart);
    studentLabel = 'Whole Family';
  } else if (student) {
    months = await attendanceForSchoolYear(student.id, schoolYearStart);
    studentLabel = student.name;
  }
  res.render('parent-family-school-attendance-print', {
    title: 'Family Attendance',
    mode: 'single',
    studentLabel,
    MONTH_NAMES,
    schoolYearLabel: `${schoolYearStart}-${schoolYearStart + 1}`,
    months,
  });
});

// --- Teacher Journal subpage - a real request: "Subpage for teacher
// journal. Add journal/notes entry by date and by student in the
// family. Full edit description typing box. Then a log below showing
// all entries." A later real request: "Teacher journal should be
// called daily learning log" - renamed everywhere it's user-facing
// (nav label, title, h1); the route/view/table names themselves stay
// "journal" (an internal implementation detail, not worth a mechanical
// rename-everything pass). ---

router.get('/family-school/journal', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const isOwnStudent = selectedStudentId && familyStudents.some((s) => s.id === selectedStudentId);
  const entries = isOwnStudent ? await journalEntriesForStudent(selectedStudentId) : [];
  for (const e of entries) e.attachments = await attachmentsForJournalEntry(e.id);
  res.render('parent-family-school-journal', {
    title: 'Daily Learning Log',
    familyStudents,
    selectedStudentId: isOwnStudent ? selectedStudentId : null,
    entries,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/family-school/journal/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const entries = student ? await journalEntriesForStudent(student.id) : [];
  const lines = [toCsvRow(['Student', 'Date', 'Notes']), ...entries.map((e) => toCsvRow([student.name, e.entry_date, plainText(e.body)]))];
  sendCsv(res, 'teacher-journal.csv', lines);
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - every family student's own
// entries, the same scope the old download.csv route used, now a PDF
// built from the exact same -print.ejs view the Print button opens.
router.get('/family-school/journal/download.pdf', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const familyRows = [];
  for (const student of familyStudents) {
    const entries = await journalEntriesForStudent(student.id);
    for (const e of entries) e.attachments = await attachmentsForJournalEntry(e.id);
    familyRows.push({ student, entries });
  }
  const pdf = await renderViewToPdf(req, 'parent-family-school-journal-print', {
    title: 'Daily Learning Log',
    mode: 'family',
    familyRows,
  });
  sendPdf(res, 'teacher-journal-all.pdf', pdf);
});

// A real request: "All print button should show a print preview full
// real page on a page with a print button."
router.get('/family-school/journal/print', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const entries = student ? await journalEntriesForStudent(student.id) : [];
  for (const e of entries) e.attachments = await attachmentsForJournalEntry(e.id);
  res.render('parent-family-school-journal-print', {
    title: 'Daily Learning Log',
    mode: 'single',
    studentLabel: student ? student.name : '',
    entries,
  });
});

async function requireOwnStudent(req, studentId) {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  return familyStudents.some((s) => s.id === studentId);
}

// A real request: "Be able to upload images or documents to daily
// learning log." Up to 5 files per entry, same attachmentUpload config
// (size limit/allowed types) the lesson-content attachment route above
// already uses - just .array() instead of .single() since an entry can
// carry more than one file.
function uploadJournalAttachments(req, res, next) {
  attachmentUpload.array('attachments', 5)(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect(
        `/parent/family-school/journal?studentId=${req.body.studentId || ''}&error=` +
          encodeURIComponent(`One of those files is too large - attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB each.`)
      );
    }
    next(err);
  });
}

router.post('/family-school/journal', uploadJournalAttachments, async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  if (!(await requireOwnStudent(req, studentId))) return res.status(404).send('Not found');
  const entryDate = (req.body.entryDate || '').trim();
  const body = sanitizePostBody(req.body.body || '');
  if (!entryDate) return res.redirect(`/parent/family-school/journal?studentId=${studentId}&error=` + encodeURIComponent('Choose a date.'));
  if (!body || body === '<p></p>') return res.redirect(`/parent/family-school/journal?studentId=${studentId}&error=` + encodeURIComponent('Write something first.'));
  const entryId = await createJournalEntry({ studentId, entryDate, body, createdByAccountId: req.portalAccount.id });
  for (const file of req.files || []) {
    await addJournalAttachment({ journalEntryId: entryId, file });
  }
  res.redirect(`/parent/family-school/journal?studentId=${studentId}&notice=` + encodeURIComponent('Journal entry added.'));
});

router.post('/family-school/journal/:id/delete', async (req, res) => {
  const entry = await getJournalEntry(parseInt(req.params.id, 10));
  if (!entry || !(await requireOwnStudent(req, entry.student_id))) return res.status(404).send('Not found');
  await deleteJournalEntry(entry.id);
  res.redirect(`/parent/family-school/journal?studentId=${entry.student_id}&notice=` + encodeURIComponent('Entry removed.'));
});

router.post('/family-school/journal/:id/attachments/:attachmentId/delete', async (req, res) => {
  const entry = await getJournalEntry(parseInt(req.params.id, 10));
  if (!entry || !(await requireOwnStudent(req, entry.student_id))) return res.status(404).send('Not found');
  const attachment = await getJournalAttachment(parseInt(req.params.attachmentId, 10));
  if (!attachment || attachment.journal_entry_id !== entry.id) return res.status(404).send('Not found');
  await deleteJournalAttachment(attachment.id);
  res.redirect(`/parent/family-school/journal?studentId=${entry.student_id}&notice=` + encodeURIComponent('Attachment removed.'));
});

// --- Volunteer Hours subpage - a real request: "Family school
// management, add a subpage for volunteer hours. Be able to track and
// add volunteer hours per student and have a log." Same per-student
// owner-select UX as Attendance/Journal above. ---

router.get('/family-school/volunteer-hours', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const isOwnStudent = selectedStudentId && familyStudents.some((s) => s.id === selectedStudentId);
  const entries = isOwnStudent ? await volunteerHoursForStudent(selectedStudentId) : [];
  const totalHours = isOwnStudent ? await totalVolunteerHoursForStudent(selectedStudentId) : 0;
  res.render('parent-family-school-volunteer-hours', {
    title: 'Volunteer Hours',
    familyStudents,
    selectedStudentId: isOwnStudent ? selectedStudentId : null,
    entries,
    totalHours,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/family-school/volunteer-hours/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const student = familyStudents.find((s) => s.id === selectedStudentId);
  const entries = student ? await volunteerHoursForStudent(student.id) : [];
  const lines = [toCsvRow(['Student', 'Date', 'Hours', 'Activity']), ...entries.map((e) => toCsvRow([student.name, e.hour_date, e.hours, e.activity_description || '']))];
  sendCsv(res, 'volunteer-hours.csv', lines);
});

router.post('/family-school/volunteer-hours', async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  if (!(await requireOwnStudent(req, studentId))) return res.status(404).send('Not found');
  const hourDate = (req.body.hourDate || '').trim();
  const hours = Number(req.body.hours);
  const activityDescription = (req.body.activityDescription || '').trim();
  const backUrl = `/parent/family-school/volunteer-hours?studentId=${studentId}`;
  if (!isValidISODate(hourDate)) return res.redirect(`${backUrl}&error=` + encodeURIComponent('Choose a valid date.'));
  if (!Number.isFinite(hours) || hours <= 0) return res.redirect(`${backUrl}&error=` + encodeURIComponent('Hours must be a positive number.'));
  await createVolunteerHourEntry({ studentId, hourDate, hours, activityDescription, createdByAccountId: req.portalAccount.id });
  res.redirect(`${backUrl}&notice=` + encodeURIComponent('Volunteer hours added.'));
});

router.post('/family-school/volunteer-hours/:id/delete', async (req, res) => {
  const entry = await getVolunteerHourEntry(parseInt(req.params.id, 10));
  if (!entry || !(await requireOwnStudent(req, entry.student_id))) return res.status(404).send('Not found');
  await deleteVolunteerHourEntry(entry.id);
  res.redirect(`/parent/family-school/volunteer-hours?studentId=${entry.student_id}&notice=` + encodeURIComponent('Entry removed.'));
});

// --- Annual Planner subpage - a real request: "Family management
// should also have a subpage called annual planner where it is
// organized by student and you add curriculum under each student. Pop
// up asks for curriculum name, brand, level and price." ---

// A real request: "Add a dropdown menu for selecting a school year...
// and so on." 'all' is the one non-"YYYY-YYYY" value the dropdown can
// carry - resolved to null (curriculumForStudent's own "no filter" mode)
// everywhere a school year is read from the query string.
function resolveSchoolYearFilter(req) {
  return req.query.schoolYear === 'all' ? null : req.query.schoolYear || currentSchoolYear();
}

async function curriculumByStudentFor(familyStudents, schoolYear) {
  const curriculumByStudent = {};
  for (const s of familyStudents) curriculumByStudent[s.id] = await curriculumForStudent(s.id, schoolYear);
  return curriculumByStudent;
}

router.get('/family-school/annual-planner', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const schoolYear = resolveSchoolYearFilter(req);
  res.render('parent-family-school-annual-planner', {
    title: 'Annual Planner',
    familyStudents,
    curriculumByStudent: await curriculumByStudentFor(familyStudents, schoolYear),
    schoolYear: schoolYear || 'all',
    currentSchoolYearValue: currentSchoolYear(),
    yearOptions: schoolYearOptions(schoolYear),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/annual-planner', async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  if (!(await requireOwnStudent(req, studentId))) return res.status(404).send('Not found');
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/parent/family-school/annual-planner?error=' + encodeURIComponent('A curriculum name is required.'));
  await createCurriculumItem({
    studentId,
    name,
    subject: (req.body.subject || '').trim(),
    brand: (req.body.brand || '').trim(),
    level: (req.body.level || '').trim(),
    price: (req.body.price || '').trim(),
    schoolYear: (req.body.schoolYear || '').trim() || currentSchoolYear(),
    createdByAccountId: req.portalAccount.id,
  });
  res.redirect('/parent/family-school/annual-planner?notice=' + encodeURIComponent('Curriculum added.'));
});

router.post('/family-school/annual-planner/:id/delete', async (req, res) => {
  const item = await getCurriculumItem(parseInt(req.params.id, 10));
  if (!item || !(await requireOwnStudent(req, item.student_id))) return res.status(404).send('Not found');
  await deleteCurriculumItem(item.id);
  res.redirect('/parent/family-school/annual-planner?notice=' + encodeURIComponent('Curriculum removed.'));
});

// A real request: "Add a print, pdf and export icons." Export/Download
// both cover the same current school-year filter (this page has no
// per-student selector the way Attendance/Grades/Journal do - it always
// shows every family student at once), so unlike those pages there's no
// separate "one student vs whole family" scope split here.
function curriculumCsvRows(curriculumByStudent, familyStudents) {
  const lines = [toCsvRow(['Student', 'Subject', 'Curriculum', 'Brand', 'Level', 'Price', 'School Year'])];
  for (const s of familyStudents) {
    for (const item of curriculumByStudent[s.id]) {
      lines.push(toCsvRow([s.name, item.subject || '', item.name, item.brand || '', item.level || '', item.price != null ? item.price : '', item.school_year || '']));
    }
  }
  return lines;
}

router.get('/family-school/annual-planner/export.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const schoolYear = resolveSchoolYearFilter(req);
  sendCsv(res, 'annual-planner.csv', curriculumCsvRows(await curriculumByStudentFor(familyStudents, schoolYear), familyStudents));
});

router.get('/family-school/annual-planner/download.pdf', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const schoolYear = resolveSchoolYearFilter(req);
  const pdf = await renderViewToPdf(req, 'parent-family-school-annual-planner-print', {
    title: 'Annual Planner',
    familyStudents,
    curriculumByStudent: await curriculumByStudentFor(familyStudents, schoolYear),
    schoolYear: schoolYear || 'All Years',
  });
  sendPdf(res, 'annual-planner.pdf', pdf);
});

router.get('/family-school/annual-planner/print', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const schoolYear = resolveSchoolYearFilter(req);
  res.render('parent-family-school-annual-planner-print', {
    title: 'Annual Planner',
    familyStudents,
    curriculumByStudent: await curriculumByStudentFor(familyStudents, schoolYear),
    schoolYear: schoolYear || 'All Years',
  });
});

// --- Weekly Planner subpage - originally "The other new planner page
// under family school management should be called schedule planner"
// (later renamed: "Change schedule planner to weekly planner"), then
// redesigned by a real follow-up request: "Add week button. Popup
// allows you to choose up to 7 dates. And add a title such as week 1,
// week 2 etc. Create and cancel buttons. Then it creates a grid with
// those dates. Add an assignment button. Pop up allows you to write
// subject, title of assignment or dropdown to choose an assignment
// from family management assignments from parent created classes.
// Save, cancel. Buttons. Print should show the whole week on one page
// clean. Title should be the students name and the date range for the
// week. Weekly plan should allow you to make a different weekly plan
// for each student, parent weekly plan and family weekly plan." ---

// 'parent' and 'family' are the two non-student owners the request
// above calls for; anything else is read as a specific family student
// id. Falls back to the family's first student (or 'family' if there
// are none) - never an id that isn't actually this family's own.
function resolveWeekOwner(req, familyStudents) {
  const raw = req.query.owner || (familyStudents[0] ? String(familyStudents[0].id) : 'family');
  if (raw === 'parent' || raw === 'family') return { ownerType: raw, studentId: null };
  const studentId = parseInt(raw, 10);
  if (familyStudents.some((s) => s.id === studentId)) return { ownerType: 'student', studentId };
  return { ownerType: 'family', studentId: null };
}

function ownerParam(owner) {
  return owner.ownerType === 'student' ? String(owner.studentId) : owner.ownerType;
}

function ownerDisplayLabel(owner, familyStudents) {
  if (owner.ownerType === 'parent') return 'Parent';
  if (owner.ownerType === 'family') return 'Whole Family';
  const student = familyStudents.find((s) => s.id === owner.studentId);
  return student ? student.name : '';
}

// Shared by every write route below - a week outside this account's own
// family is simply not found, never a raw/unscoped lookup (same "never
// trust an id from the request alone" rule requireOwnClass/
// requireOwnLesson already document above).
async function requireOwnWeek(req, weekId) {
  const week = await getWeek(weekId);
  if (!week) return null;
  const familyId = await familyIdForAccount(req.portalAccount);
  return week.family_id === familyId ? week : null;
}

router.get('/family-school/weekly-planner', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const owner = resolveWeekOwner(req, familyStudents);
  const weeks = await weeksForOwner(familyId, owner.ownerType, owner.studentId);
  const selectedWeekId = req.query.weekId ? parseInt(req.query.weekId, 10) : null;
  const selectedWeek = selectedWeekId ? weeks.find((w) => w.id === selectedWeekId) : null;
  let grid = null;
  let subjectBreakdown = null;
  if (selectedWeek) {
    grid = await weekGrid(selectedWeek.id);
    grid.forEach((d) => { d.dateLabel = formatDateLabel(d.date); });
    subjectBreakdown = subjectBreakdownForGrid(grid);
  }

  res.render('parent-family-school-weekly-planner', {
    title: 'Weekly Planner',
    familyStudents,
    owner,
    ownerParam: ownerParam(owner),
    weeks,
    selectedWeek,
    grid,
    subjectBreakdown,
    assignmentOptions: await assignmentOptionsForFamily(familyId),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/weekly-planner', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const ownerTypeRaw = (req.body.ownerType || '').trim();
  const studentId = ownerTypeRaw === 'student' ? parseInt(req.body.studentId, 10) : null;
  const backUrl = `/parent/family-school/weekly-planner?owner=${encodeURIComponent(req.body.ownerType === 'student' ? req.body.studentId : ownerTypeRaw)}`;
  if (!['student', 'parent', 'family'].includes(ownerTypeRaw)) return res.redirect(`${backUrl}&error=` + encodeURIComponent('Choose who this week is for.'));
  if (ownerTypeRaw === 'student' && !familyStudents.some((s) => s.id === studentId)) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`${backUrl}&error=` + encodeURIComponent('A title (e.g. "Week 1") is required.'));
  // "Choose up to 7 dates" - the form sends up to 7 same-named fields;
  // blanks (left-empty optional date pickers) are dropped, and at least
  // one real date is required to make a grid out of.
  const dates = [...new Set([].concat(req.body.date || []).map((d) => (d || '').trim()).filter((d) => isValidISODate(d)))].slice(0, 7);
  if (dates.length === 0) return res.redirect(`${backUrl}&error=` + encodeURIComponent('Choose at least one date.'));
  const weekId = await createWeek({ familyId, ownerType: ownerTypeRaw, studentId, title, dates, createdByAccountId: req.portalAccount.id });
  res.redirect(`/parent/family-school/weekly-planner?owner=${encodeURIComponent(ownerTypeRaw === 'student' ? studentId : ownerTypeRaw)}&weekId=${weekId}&notice=` + encodeURIComponent('Week created.'));
});

router.post('/family-school/weekly-planner/:id/delete', async (req, res) => {
  const week = await requireOwnWeek(req, parseInt(req.params.id, 10));
  if (!week) return res.status(404).send('Not found');
  await deleteWeek(week.id);
  const owner = week.owner_type === 'student' ? week.student_id : week.owner_type;
  res.redirect(`/parent/family-school/weekly-planner?owner=${encodeURIComponent(owner)}&notice=` + encodeURIComponent('Week removed.'));
});

router.post('/family-school/weekly-planner/dates/:dateId/assignments', async (req, res) => {
  const weekDate = await getWeekDate(parseInt(req.params.dateId, 10));
  const week = weekDate && (await requireOwnWeek(req, weekDate.week_id));
  if (!week) return res.status(404).send('Not found');
  const owner = week.owner_type === 'student' ? week.student_id : week.owner_type;
  const backUrl = `/parent/family-school/weekly-planner?owner=${encodeURIComponent(owner)}&weekId=${week.id}`;

  const familyId = await familyIdForAccount(req.portalAccount);
  const contentItemId = req.body.contentItemId ? parseInt(req.body.contentItemId, 10) : null;
  let subject = (req.body.subject || '').trim();
  let title = (req.body.title || '').trim();
  if (contentItemId) {
    // "Dropdown to choose an assignment from family management
    // assignments from parent created classes" - only ever a real
    // assignment this same family actually created; never trusts the
    // posted contentItemId blindly (same join assignmentOptionsForFamily
    // itself already scopes by family_id).
    const picked = (await assignmentOptionsForFamily(familyId)).find((a) => a.id === contentItemId);
    if (!picked) return res.status(404).send('Not found');
    subject = subject || picked.class_name;
    title = title || picked.title || picked.class_name;
  }
  if (!title) return res.redirect(`${backUrl}&error=` + encodeURIComponent('A title is required.'));
  await createWeekAssignment({ weekDateId: weekDate.id, subject, title, contentItemId });
  res.redirect(`${backUrl}&notice=` + encodeURIComponent('Assignment added.'));
});

router.post('/family-school/weekly-planner/assignments/:id/delete', async (req, res) => {
  const assignment = await getWeekAssignment(parseInt(req.params.id, 10));
  const weekDate = assignment && (await getWeekDate(assignment.week_date_id));
  const week = weekDate && (await requireOwnWeek(req, weekDate.week_id));
  if (!week) return res.status(404).send('Not found');
  await deleteWeekAssignment(assignment.id);
  const owner = week.owner_type === 'student' ? week.student_id : week.owner_type;
  res.redirect(`/parent/family-school/weekly-planner?owner=${encodeURIComponent(owner)}&weekId=${week.id}&notice=` + encodeURIComponent('Assignment removed.'));
});

// A real request: "allow to drag and drop lessons and assignments
// between days." A drag-and-drop action, not a full-page form submit -
// JSON in/out, like routes/teacher-portal.js's own barcode-scan routes.
// Same ownership check as the delete route above, PLUS a second check
// that the drop target date belongs to this SAME week - a drag can only
// ever originate from (and the client-side JS only ever offers) a date
// column already rendered as part of the one selectedWeek on this page,
// but the request body is still never trusted blindly.
router.post('/family-school/weekly-planner/assignments/:id/move', async (req, res) => {
  const assignment = await getWeekAssignment(parseInt(req.params.id, 10));
  const weekDate = assignment && (await getWeekDate(assignment.week_date_id));
  const week = weekDate && (await requireOwnWeek(req, weekDate.week_id));
  if (!week) return res.json({ ok: false, message: 'Not found.' });
  const newWeekDateId = parseInt(req.body.weekDateId, 10);
  const targetDate = await getWeekDate(newWeekDateId);
  if (!targetDate || targetDate.week_id !== week.id) return res.json({ ok: false, message: 'That day is not part of this week.' });
  await moveWeekAssignment(assignment.id, newWeekDateId);
  res.json({ ok: true });
});

// A real request: "Print should show the whole week on one page clean.
// Title should be the students name and the date range for the week."
async function weeklyPlannerPrintLocals(req) {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const week = await requireOwnWeek(req, parseInt(req.query.weekId, 10));
  if (!week) return null;
  const dates = await weekGrid(week.id);
  dates.forEach((d) => { d.dateLabel = formatDateLabel(d.date); });
  return {
    title: 'Weekly Planner',
    week,
    ownerLabel: ownerDisplayLabel(week.owner_type === 'student' ? { ownerType: 'student', studentId: week.student_id } : { ownerType: week.owner_type }, familyStudents),
    dateRangeLabel: weekDateRangeLabel(dates),
    dates,
    subjectBreakdown: subjectBreakdownForGrid(dates),
  };
}

router.get('/family-school/weekly-planner/print', async (req, res) => {
  const locals = await weeklyPlannerPrintLocals(req);
  if (!locals) return res.status(404).send('Not found');
  res.render('parent-family-school-weekly-planner-print', locals);
});

router.get('/family-school/weekly-planner/download.pdf', async (req, res) => {
  const locals = await weeklyPlannerPrintLocals(req);
  if (!locals) return res.status(404).send('Not found');
  const pdf = await renderViewToPdf(req, 'parent-family-school-weekly-planner-print', locals);
  sendPdf(res, 'weekly-planner.pdf', pdf);
});

// A real request: "add a subpage called portfolio. This will summarize
// all family school management features for each student and create a
// visual profile of everything. Pdf and print view." One student at a
// time (a per-student owner-select, same convention as Weekly Planner/
// Attendance/Journal above) rather than every student at once, since
// "a visual profile" reads as a single student's own portfolio, not a
// family-wide summary page (that's what the bare Overview page already
// is). portfolioForStudent (utils/familySchool.js) does all the
// aggregation; this route is just picking which student and loading it.
async function resolvePortfolioStudent(req) {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  if (familyStudents.length === 0) return { familyStudents, studentId: null, portfolio: null };
  const requestedId = req.query.studentId ? parseInt(req.query.studentId, 10) : null;
  const studentId = requestedId && familyStudents.some((s) => s.id === requestedId) ? requestedId : familyStudents[0].id;
  const portfolio = await portfolioForStudent(studentId);
  return { familyStudents, studentId, portfolio };
}

router.get('/family-school/portfolio', async (req, res) => {
  const { familyStudents, studentId, portfolio } = await resolvePortfolioStudent(req);
  res.render('parent-family-school-portfolio', {
    title: 'Portfolio',
    familyStudents,
    studentId,
    portfolio,
    avatarColorFor,
  });
});

router.get('/family-school/portfolio/print', async (req, res) => {
  const { familyStudents, studentId, portfolio } = await resolvePortfolioStudent(req);
  if (!portfolio) return res.status(404).send('Not found');
  res.render('parent-family-school-portfolio-print', { title: 'Portfolio', familyStudents, studentId, portfolio, avatarColorFor });
});

router.get('/family-school/portfolio/download.pdf', async (req, res) => {
  const { familyStudents, studentId, portfolio } = await resolvePortfolioStudent(req);
  if (!portfolio) return res.status(404).send('Not found');
  const pdf = await renderViewToPdf(req, 'parent-family-school-portfolio-print', { title: 'Portfolio', familyStudents, studentId, portfolio, avatarColorFor });
  sendPdf(res, `portfolio-${portfolio.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`, pdf);
});

module.exports = router;
