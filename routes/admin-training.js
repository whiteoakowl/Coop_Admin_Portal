// Training & Learning module - admin side (Training Builder, Assignment,
// Reporting). See utils/training.js's own header for the module's full
// design. Gated behind plain requireAdmin, same as Setup/Cleanup and
// Floater Assignments - there's no separate "manager" role in this app
// (a single shared Admin login - see requireAdmin.js's own comment), so
// "Admin/Manager" from the module's own design brief is just "Admin"
// here.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const requireAdmin = require('../middleware/requireAdmin');
const { imageFileFilter } = require('../utils/uploads');
const { saveUpload, removeUpload } = require('../utils/uploadBackend');
const { createStorageClient } = require('../utils/storage');
const T = require('../utils/training');

const RESOURCE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'training');
const RESOURCE_BUCKET = 'training-resources';
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(RESOURCE_DIR)) fs.mkdirSync(RESOURCE_DIR, { recursive: true });
const uploadResource = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });

function backToBuilder(res, trainingId, extra) {
  const qs = extra ? '?' + new URLSearchParams(extra).toString() : '';
  res.redirect(`/admin/training/${trainingId}/builder${qs}`);
}

// ---------------------------------------------------------------------
// List / create / publish / archive / delete
// ---------------------------------------------------------------------

router.get('/training', requireAdmin, async (req, res) => {
  res.render('admin-training-list', {
    title: 'Training',
    trainings: await T.listTrainings(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training', requireAdmin, async (req, res) => {
  try {
    const id = await T.createTraining({
      title: req.body.title,
      description: req.body.description,
      estimatedMinutes: req.body.estimatedMinutes,
      passingScore: req.body.passingScore,
      sequentialLessons: !!req.body.sequentialLessons,
      requireVideoCompletion: !!req.body.requireVideoCompletion,
      videoCompletionThreshold: req.body.videoCompletionThreshold,
      requireRetakeAfterFailure: !!req.body.requireRetakeAfterFailure,
      allowSkippingLessons: !!req.body.allowSkippingLessons,
      requireManagerApproval: !!req.body.requireManagerApproval,
    });
    res.redirect(`/admin/training/${id}/builder?notice=` + encodeURIComponent('Training created. Add some lessons below.'));
  } catch (e) {
    res.redirect('/admin/training?error=' + encodeURIComponent(e.message));
  }
});

router.get('/training/:id/builder', requireAdmin, async (req, res) => {
  const training = await T.getTrainingWithContent(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-training-builder', {
    title: training.title,
    training,
    LESSON_TYPES: T.LESSON_TYPES,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training/:id/update', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.updateTraining(id, {
      title: req.body.title,
      description: req.body.description,
      estimatedMinutes: req.body.estimatedMinutes,
      passingScore: req.body.passingScore,
      sequentialLessons: !!req.body.sequentialLessons,
      requireVideoCompletion: !!req.body.requireVideoCompletion,
      videoCompletionThreshold: req.body.videoCompletionThreshold,
      requireRetakeAfterFailure: !!req.body.requireRetakeAfterFailure,
      allowSkippingLessons: !!req.body.allowSkippingLessons,
      requireManagerApproval: !!req.body.requireManagerApproval,
    });
    backToBuilder(res, id, { notice: 'Training settings saved.' });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/status', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.setTrainingStatus(id, req.body.status);
    const label = req.body.status === 'published' ? 'Training published.' : req.body.status === 'archived' ? 'Training archived.' : 'Training moved back to draft.';
    backToBuilder(res, id, { notice: label });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/delete', requireAdmin, async (req, res) => {
  const ok = await T.deleteTraining(req.params.id);
  if (ok) return res.redirect('/admin/training?notice=' + encodeURIComponent('Training deleted.'));
  backToBuilder(res, req.params.id, { error: 'Only a draft training with no assignments can be deleted - Archive it instead.' });
});

// ---------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------

router.post('/training/:id/lessons', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.createLesson(id, {
      title: req.body.title,
      description: req.body.description,
      type: req.body.type,
      required: !!req.body.required,
      videoUrl: req.body.videoUrl,
      content: req.body.content,
    });
    backToBuilder(res, id, { notice: 'Lesson added.' });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/lessons/:lessonId/update', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.updateLesson(req.params.lessonId, {
      title: req.body.title,
      description: req.body.description,
      type: req.body.type,
      required: !!req.body.required,
      videoUrl: req.body.videoUrl,
      content: req.body.content,
    });
    backToBuilder(res, id, { notice: 'Lesson updated.' });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/lessons/:lessonId/delete', requireAdmin, async (req, res) => {
  await T.deleteLesson(req.params.lessonId);
  backToBuilder(res, req.params.id, { notice: 'Lesson removed.' });
});

router.post('/training/:id/lessons/:lessonId/move', requireAdmin, async (req, res) => {
  await T.moveLesson(req.params.lessonId, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect(`/admin/training/${req.params.id}/builder`);
});

// Resource images - reuses the exact same multer memoryStorage +
// Storage-or-local-disk upload pattern member photos already use (see
// routes/admin-members.js's own PHOTO_DIR/uploadPhoto/savePhotoFile).
router.post('/training/:id/lessons/:lessonId/resources', requireAdmin, uploadResource.single('file'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return backToBuilder(res, id, { error: 'Choose an image to upload.' });
  const key = await saveUpload({
    client: storageClient,
    bucket: RESOURCE_BUCKET,
    localDir: RESOURCE_DIR,
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    contentType: req.file.mimetype,
  });
  await T.addLessonResource(req.params.lessonId, key, req.file.originalname);
  backToBuilder(res, id, { notice: 'Image added.' });
});

router.post('/training/:id/lessons/:lessonId/resources/:resourceId/delete', requireAdmin, async (req, res) => {
  const filePath = await T.deleteLessonResource(req.params.resourceId);
  if (filePath) await removeUpload({ client: storageClient, bucket: RESOURCE_BUCKET, localDir: RESOURCE_DIR, key: filePath });
  backToBuilder(res, req.params.id, { notice: 'Image removed.' });
});

// ---------------------------------------------------------------------
// Quiz questions
// ---------------------------------------------------------------------

// Options arrive as parallel arrays from the quiz question dialog's
// repeatable option rows - optionText[] and a single correctIndex
// (radio button, so only one option can ever be "the" answer for this
// question type - see utils/training.js's own comment on why multiple-
// choice's one-correct-answer shape is what future question types like
// multiple-answer would need their own, different validation for).
function optionsFromBody(body) {
  const texts = [].concat(body.optionText || []);
  const correctIndex = parseInt(body.correctIndex, 10);
  return texts.map((text, i) => ({ text, correct: i === correctIndex }));
}

router.post('/training/:id/lessons/:lessonId/questions', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.createQuizQuestion(req.params.lessonId, {
      question: req.body.question,
      points: req.body.points,
      options: optionsFromBody(req.body),
    });
    backToBuilder(res, id, { notice: 'Question added.' });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/lessons/:lessonId/questions/:questionId/update', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await T.updateQuizQuestion(req.params.questionId, {
      question: req.body.question,
      points: req.body.points,
      options: optionsFromBody(req.body),
    });
    backToBuilder(res, id, { notice: 'Question updated.' });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/lessons/:lessonId/questions/:questionId/delete', requireAdmin, async (req, res) => {
  await T.deleteQuizQuestion(req.params.questionId);
  backToBuilder(res, req.params.id, { notice: 'Question removed.' });
});

router.post('/training/:id/lessons/:lessonId/questions/:questionId/move', requireAdmin, async (req, res) => {
  await T.moveQuizQuestion(req.params.questionId, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect(`/admin/training/${req.params.id}/builder`);
});

// ---------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------

router.get('/training/:id/assign', requireAdmin, async (req, res) => {
  const training = await T.getTraining(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-training-assign', {
    title: `Assign - ${training.title}`,
    training,
    members: await T.activeAssignableMembers(),
    alreadyAssigned: new Set((await T.assignmentsForTraining(training.id)).map((a) => a.member_id)),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training/:id/assign', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  if (!memberIds.length) {
    return res.redirect(`/admin/training/${id}/assign?error=` + encodeURIComponent('Select at least one member.'));
  }
  const dueAt = req.body.dueAt && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueAt) ? req.body.dueAt : null;
  const count = await T.assignTrainingToMembers(id, memberIds, dueAt);
  res.redirect(`/admin/training/${id}/report?notice=` + encodeURIComponent(`Assigned to ${count} member(s).`));
});

router.post('/training/:id/assignments/:assignmentId/remove', requireAdmin, async (req, res) => {
  await T.removeAssignment(req.params.assignmentId);
  res.redirect(`/admin/training/${req.params.id}/report?notice=` + encodeURIComponent('Assignment removed.'));
});

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

router.get('/training/:id/report', requireAdmin, async (req, res) => {
  const training = await T.getTraining(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-training-report', {
    title: `Report - ${training.title}`,
    training,
    rows: await T.assignmentsForTraining(training.id),
    notice: req.query.notice || null,
  });
});

router.get('/training/:id/assignments/:assignmentId', requireAdmin, async (req, res) => {
  const training = await T.getTraining(req.params.id);
  const detail = await T.assignmentDetail(req.params.assignmentId);
  if (!training || !detail || detail.training_id !== training.id) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-training-assignment-detail', { title: `${detail.memberName} - ${training.title}`, training, detail });
});

module.exports = router;
