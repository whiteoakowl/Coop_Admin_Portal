// Family School Management (Main Admin side) - a real request: "On main
// admin the family school management tab simply has settings. Leave
// settings for that blank for now." routes/main-admin-family-school.js
// used to render nothing but a blank placeholder page here.
// A later real request: "Main admin portal. Family school management
// tab should simply have two subpages. One for transcript creation and
// one for diploma creation. Same pages and features as the family
// school management portal for transcripts and diplomas." Parent
// Portal's own Transcripts/Diplomas pages (routes/parent-portal.js's
// own /academics and /academics/diplomas) are a parent's SELF-SERVICE
// tool, always scoped to "my own children" (childrenForAccount there).
// Main Admin needs the exact same builder/designer, just scoped to ANY
// active student in the co-op instead - a student picker (a plain
// <select>, same onchange="window.location.href = ...?studentId=" GET-
// navigation convention as e.g. views/admin-orientation.ejs's own
// semester picker) stands in for "which family" a parent never has to
// ask. Rather than hand-copy that whole designer a second time, the
// actual per-student markup+JS lives in two shared partials (views/
// partials/transcript-student-builder.ejs, views/partials/diploma-
// student-builder.ejs) that both this file and routes/parent-portal.js
// render, and the GPA-builder data for one student comes from the same
// utils/academics.js helper (transcriptBuilderDataForStudent) both
// routes call - see that function's own header comment.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { byLastName } = require('../utils/members');
const { listSemesters } = require('../utils/classSchedule');
const { todayISO } = require('../utils/dates');
const {
  transcriptBuilderForStudent,
  transcriptBuilderDataForStudent,
  createTranscriptEntry,
  getTranscriptEntry,
  updateTranscriptEntry,
  deleteTranscriptEntry,
  TRANSCRIPT_GRADE_LETTERS,
  diplomaForStudent,
  issueDiploma,
  DIPLOMA_TEMPLATES,
} = require('../utils/academics');
const { renderViewToPdf } = require('../utils/pdfRender');
const {
  classesForStudent: familySchoolClassesForStudent,
  getFamilySchoolSettings,
  familySettingsForPdf,
  schoolYearOptions,
  currentSchoolYear,
} = require('../utils/familySchool');

router.use(requirePortalAuth, requirePortal('main_admin'));

// Every active student in the co-op, regardless of family - the picker
// both subpages below use. Unlike Parent Portal's own childrenForAccount,
// this never scopes to one family; Main Admin can build a transcript or
// design a diploma for anyone.
async function allActiveStudents() {
  return (await db.prepare("SELECT * FROM members WHERE member_type = 'student' AND active = 1").all()).sort(byLastName);
}

async function requireStudent(studentId) {
  if (!Number.isFinite(studentId)) return null;
  return db.prepare("SELECT * FROM members WHERE id = ? AND member_type = 'student' AND active = 1").get(studentId) || null;
}

function sendPdf(res, filename, pdfBuffer) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
}

// --- Transcripts ---

router.get('/family-school', async (req, res) => {
  const students = await allActiveStudents();
  const selectedStudent = (await requireStudent(parseInt(req.query.studentId, 10))) || null;
  const semesters = await listSemesters();
  const yearOptions = schoolYearOptions(currentSchoolYear());
  let rec = null;
  if (selectedStudent) {
    const { builder, coopClassesBySemester } = await transcriptBuilderDataForStudent(selectedStudent.id, semesters);
    rec = {
      child: selectedStudent,
      builder,
      familyClasses: (await familySchoolClassesForStudent(selectedStudent.id)).map((c) => c.class_name),
      coopClassesBySemester,
    };
  }
  res.render('main-admin-family-school-transcripts', {
    title: 'Family School Management',
    students,
    selectedStudent,
    rec,
    semesters,
    yearOptions,
    currentSchoolYearValue: currentSchoolYear(),
    gradeLetters: TRANSCRIPT_GRADE_LETTERS,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/transcripts', async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.status(404).send('Not found');
  const schoolYear = (req.body.schoolYear || '').trim();
  const className = (req.body.className || '').trim();
  if (!schoolYear || !className) {
    return res.redirect(`/main-admin/family-school?studentId=${studentId}&error=` + encodeURIComponent('A school year and class name are required.'));
  }
  const creditHours = parseFloat(req.body.creditHours);
  const gradeLetter = TRANSCRIPT_GRADE_LETTERS.includes(req.body.gradeLetter) ? req.body.gradeLetter : null;
  await createTranscriptEntry({
    studentId,
    schoolYear,
    className,
    creditHours: Number.isFinite(creditHours) && creditHours > 0 ? creditHours : 1,
    gradeLetter,
    createdByAccountId: req.portalAccount.id,
  });
  res.redirect(`/main-admin/family-school?studentId=${studentId}&notice=` + encodeURIComponent('Class added to transcript.'));
});

router.post('/family-school/transcripts/:id/edit', async (req, res) => {
  const entry = await getTranscriptEntry(parseInt(req.params.id, 10));
  if (!entry) return res.status(404).send('Not found');
  const schoolYear = (req.body.schoolYear || '').trim();
  const className = (req.body.className || '').trim();
  if (!schoolYear || !className) {
    return res.redirect(`/main-admin/family-school?studentId=${entry.student_id}&error=` + encodeURIComponent('A school year and class name are required.'));
  }
  const creditHours = parseFloat(req.body.creditHours);
  const gradeLetter = TRANSCRIPT_GRADE_LETTERS.includes(req.body.gradeLetter) ? req.body.gradeLetter : null;
  await updateTranscriptEntry(entry.id, { schoolYear, className, creditHours: Number.isFinite(creditHours) && creditHours > 0 ? creditHours : 1, gradeLetter });
  res.redirect(`/main-admin/family-school?studentId=${entry.student_id}&notice=` + encodeURIComponent('Transcript entry updated.'));
});

router.post('/family-school/transcripts/:id/delete', async (req, res) => {
  const entry = await getTranscriptEntry(parseInt(req.params.id, 10));
  if (!entry) return res.status(404).send('Not found');
  const studentId = entry.student_id;
  await deleteTranscriptEntry(entry.id);
  res.redirect(`/main-admin/family-school?studentId=${studentId}&notice=` + encodeURIComponent('Entry removed.'));
});

router.get('/family-school/transcripts/:studentId/print', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.status(404).render('404', { title: 'Not Found' });
  res.render('parent-academics-transcript-print', {
    title: 'Transcript',
    member: student,
    builder: await transcriptBuilderForStudent(studentId),
    familySettings: await getFamilySchoolSettings(student.family_id),
    portalTitle: 'Main Admin',
    backHref: `/main-admin/family-school?studentId=${studentId}`,
  });
});

router.get('/family-school/transcripts/:studentId/download.pdf', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.status(404).send('Not found');
  const pdf = await renderViewToPdf(req, 'parent-academics-transcript-print', {
    title: 'Transcript',
    member: student,
    builder: await transcriptBuilderForStudent(studentId),
    familySettings: await familySettingsForPdf(await getFamilySchoolSettings(student.family_id)),
    portalTitle: 'Main Admin',
    backHref: `/main-admin/family-school?studentId=${studentId}`,
  });
  sendPdf(res, `${student.name.replace(/[^a-z0-9]+/gi, '-')}-transcript.pdf`, pdf);
});

// --- Diplomas ---

router.get('/family-school/diplomas', async (req, res) => {
  const students = await allActiveStudents();
  const selectedStudent = (await requireStudent(parseInt(req.query.studentId, 10))) || null;
  const diploma = selectedStudent ? await diplomaForStudent(selectedStudent.id) : null;
  res.render('main-admin-family-school-diplomas', {
    title: 'Family School Management',
    students,
    selectedStudent,
    diploma,
    todayISO: todayISO(),
    DIPLOMA_TEMPLATES,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/family-school/diplomas', async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.redirect('/main-admin/family-school/diplomas?error=' + encodeURIComponent('Choose a student.'));
  const title = (req.body.title || '').trim() || 'Diploma of Completion';
  const issuedDate = req.body.issuedDate || todayISO();
  const template = DIPLOMA_TEMPLATES.includes(req.body.template) ? req.body.template : 'classic';
  await issueDiploma({
    studentId,
    title,
    issuedDate,
    bodyText: req.body.bodyText,
    issuedByAccountId: req.portalAccount.id,
    template,
    color: (req.body.color || '').trim() || '#2e6da4',
    displayName: (req.body.displayName || '').trim(),
    signature1Name: (req.body.signature1Name || '').trim(),
    signature1Title: (req.body.signature1Title || '').trim(),
    signature2Name: (req.body.signature2Name || '').trim(),
    signature2Title: (req.body.signature2Title || '').trim(),
  });
  res.redirect(`/main-admin/family-school/diplomas?studentId=${studentId}&notice=` + encodeURIComponent('Diploma saved.'));
});

router.get('/family-school/diplomas/:studentId/print', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.status(404).render('404', { title: 'Not Found' });
  const diploma = await diplomaForStudent(studentId);
  if (!diploma) return res.redirect(`/main-admin/family-school/diplomas?studentId=${studentId}&error=` + encodeURIComponent('Design a diploma for this student first.'));
  res.render('parent-academics-diploma-print', {
    title: 'Diploma',
    member: student,
    diploma,
    portalTitle: 'Main Admin',
    backHref: `/main-admin/family-school/diplomas?studentId=${studentId}`,
  });
});

router.get('/family-school/diplomas/:studentId/download.pdf', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const student = await requireStudent(studentId);
  if (!student) return res.status(404).send('Not found');
  const diploma = await diplomaForStudent(studentId);
  if (!diploma) return res.redirect(`/main-admin/family-school/diplomas?studentId=${studentId}&error=` + encodeURIComponent('Design a diploma for this student first.'));
  const pdf = await renderViewToPdf(req, 'parent-academics-diploma-print', {
    title: 'Diploma',
    member: student,
    diploma,
    portalTitle: 'Main Admin',
    backHref: `/main-admin/family-school/diplomas?studentId=${studentId}`,
  });
  sendPdf(res, `${student.name.replace(/[^a-z0-9]+/gi, '-')}-diploma.pdf`, pdf);
});

module.exports = router;
