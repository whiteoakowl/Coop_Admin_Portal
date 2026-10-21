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
  toggleAttendance,
  familyAttendanceForMonth,
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
  curriculumForStudent,
  createCurriculumItem,
  getCurriculumItem,
  deleteCurriculumItem,
  mondayOf,
  getWeeklyPlanById,
  getWeeklyPlanColumn,
  getWeeklyPlanRow,
  weeklyPlanGrid,
  addWeeklyPlanColumn,
  addWeeklyPlanRow,
  deleteWeeklyPlanColumn,
  deleteWeeklyPlanRow,
  setWeeklyPlanCell,
} = require('../utils/familySchool');
const { todayISO, isValidISODate, addDays, formatDateLabel } = require('../utils/dates');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');

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

router.get('/family-school/download.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const students = await overviewForFamily(familyId);
  const lines = [toCsvRow(['Student', 'Class', 'Grade %', 'Grade Letter'])];
  for (const s of students) {
    if (s.classes.length === 0) {
      lines.push(toCsvRow([s.name, '', '', '']));
      continue;
    }
    for (const c of s.classes) lines.push(toCsvRow([s.name, c.class_name, c.gradePercent != null ? c.gradePercent.toFixed(1) : '', c.gradeLetter || '']));
  }
  sendCsv(res, 'family-school-management-detail.csv', lines);
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

router.get('/family-school/grades/download.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const lines = [toCsvRow(['Student', 'Class', 'Lesson', 'Assignment', 'Due', 'Submitted', 'Points Earned', 'Points Possible', 'Grade Letter'])];
  for (const student of familyStudents) {
    const grades = await gradesForStudent(student.id);
    for (const g of grades) {
      lines.push(
        toCsvRow([student.name, g.class_name, g.lesson_title, g.item_title || '', g.dueDateLabel || '', g.submission_id ? 'Yes' : 'No', g.points_earned != null ? g.points_earned : '', g.points_possible != null ? g.points_possible : '', g.grade_letter || ''])
      );
    }
  }
  sendCsv(res, 'family-grades-all.csv', lines);
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

router.get('/family-school/attendance/download.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const lines = [toCsvRow(['Student', 'Date', 'Status'])];
  for (const student of familyStudents) {
    const rows = await allAttendanceForStudent(student.id);
    for (const r of rows) lines.push(toCsvRow([student.name, r.attendance_date, r.status]));
  }
  sendCsv(res, 'family-attendance-all.csv', lines);
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

router.get('/family-school/journal/download.csv', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const lines = [toCsvRow(['Student', 'Date', 'Notes'])];
  for (const student of familyStudents) {
    const entries = await journalEntriesForStudent(student.id);
    for (const e of entries) lines.push(toCsvRow([student.name, e.entry_date, plainText(e.body)]));
  }
  sendCsv(res, 'teacher-journal-all.csv', lines);
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

// --- Annual Planner subpage - a real request: "Family management
// should also have a subpage called annual planner where it is
// organized by student and you add curriculum under each student. Pop
// up asks for curriculum name, brand, level and price." ---

router.get('/family-school/annual-planner', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const curriculumByStudent = {};
  for (const s of familyStudents) curriculumByStudent[s.id] = await curriculumForStudent(s.id);
  res.render('parent-family-school-annual-planner', {
    title: 'Annual Planner',
    familyStudents,
    curriculumByStudent,
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
    brand: (req.body.brand || '').trim(),
    level: (req.body.level || '').trim(),
    price: (req.body.price || '').trim(),
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

// --- Weekly Planner subpage - a real request: "The other new planner
// page under family school management should be called schedule
// planner" (later renamed again: "Change schedule planner to weekly
// planner") ("View weekly plan grid for each student. Be able to add
// rows and columns to create plan grid for the week per student.") ---

router.get('/family-school/weekly-planner', async (req, res) => {
  const familyId = await familyIdForAccount(req.portalAccount);
  const familyStudents = await studentsForFamily(familyId);
  const selectedStudentId = req.query.studentId ? parseInt(req.query.studentId, 10) : familyStudents[0] ? familyStudents[0].id : null;
  const isOwnStudent = selectedStudentId && familyStudents.some((s) => s.id === selectedStudentId);

  const weekStartDate = mondayOf(isValidISODate(req.query.week) ? req.query.week : todayISO());
  const prevWeek = addDays(weekStartDate, -7);
  const nextWeek = addDays(weekStartDate, 7);

  res.render('parent-family-school-weekly-planner', {
    title: 'Weekly Planner',
    familyStudents,
    selectedStudentId: isOwnStudent ? selectedStudentId : null,
    weeklyGrid: isOwnStudent ? await weeklyPlanGrid(selectedStudentId, weekStartDate) : null,
    weekStartLabel: formatDateLabel(weekStartDate),
    prevWeek,
    nextWeek,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// Shared by every Weekly Planner write route below - a planId outside
// this account's own family is simply not found, never a raw/unscoped
// lookup (same "never trust an id from the request alone" rule
// requireOwnClass/requireOwnLesson already document above).
async function requireOwnWeeklyPlan(req, planId) {
  const plan = await getWeeklyPlanById(planId);
  if (!plan || !(await requireOwnStudent(req, plan.student_id))) return null;
  return plan;
}

function weeklyPlannerBackUrl(plan) {
  return `/parent/family-school/weekly-planner?studentId=${plan.student_id}&week=${plan.week_start_date}`;
}

router.post('/family-school/weekly-planner/:planId/columns', async (req, res) => {
  const plan = await requireOwnWeeklyPlan(req, parseInt(req.params.planId, 10));
  if (!plan) return res.status(404).send('Not found');
  const label = (req.body.label || '').trim();
  if (!label) return res.redirect(`${weeklyPlannerBackUrl(plan)}&error=` + encodeURIComponent('A column label is required.'));
  await addWeeklyPlanColumn(plan.id, label);
  res.redirect(weeklyPlannerBackUrl(plan));
});

router.post('/family-school/weekly-planner/:planId/rows', async (req, res) => {
  const plan = await requireOwnWeeklyPlan(req, parseInt(req.params.planId, 10));
  if (!plan) return res.status(404).send('Not found');
  const label = (req.body.label || '').trim();
  if (!label) return res.redirect(`${weeklyPlannerBackUrl(plan)}&error=` + encodeURIComponent('A row label is required.'));
  await addWeeklyPlanRow(plan.id, label);
  res.redirect(weeklyPlannerBackUrl(plan));
});

router.post('/family-school/weekly-planner/columns/:id/delete', async (req, res) => {
  const column = await getWeeklyPlanColumn(parseInt(req.params.id, 10));
  const plan = column && (await requireOwnWeeklyPlan(req, column.plan_id));
  if (!plan) return res.status(404).send('Not found');
  await deleteWeeklyPlanColumn(column.id);
  res.redirect(weeklyPlannerBackUrl(plan));
});

router.post('/family-school/weekly-planner/rows/:id/delete', async (req, res) => {
  const row = await getWeeklyPlanRow(parseInt(req.params.id, 10));
  const plan = row && (await requireOwnWeeklyPlan(req, row.plan_id));
  if (!plan) return res.status(404).send('Not found');
  await deleteWeeklyPlanRow(row.id);
  res.redirect(weeklyPlannerBackUrl(plan));
});

// AJAX endpoint (public/js/family-school-planner.js) - saves one cell's
// own content on blur, no full page reload, same shape public/js/
// family-school-attendance.js's own toggle fetch() already uses.
router.post('/family-school/weekly-planner/cell', async (req, res) => {
  const rowId = parseInt(req.body.rowId, 10);
  const columnId = parseInt(req.body.columnId, 10);
  const row = await getWeeklyPlanRow(rowId);
  const plan = row && (await requireOwnWeeklyPlan(req, row.plan_id));
  if (!plan) return res.status(404).json({ ok: false });
  const column = await getWeeklyPlanColumn(columnId);
  if (!column || column.plan_id !== row.plan_id) return res.status(404).json({ ok: false });
  await setWeeklyPlanCell(rowId, columnId, (req.body.content || '').trim());
  res.json({ ok: true });
});

module.exports = router;
