// Training & Learning module, mirrored into Main Admin - a real request:
// "the training tab should also be on main admin portal. the features
// should be exactly the same." Deliberately NOT a fork of the data layer
// (utils/training.js) or the Builder/Assign/Report business logic -
// every T.* call here is the exact same shared module routes/admin-
// training.js already uses, and training/lessons/quiz_questions/
// assignments are shared tables either portal edits, same precedent as
// Name Tags (see routes/main-admin-name-tags.js's own header comment) -
// a training built from either portal is the same training, not two
// drifting copies. Only the route wiring/auth gate (Main Admin's
// requirePortalPermission instead of Co-op Admin's requireAdmin) and the
// views (Main Admin's own portal-nav instead of admin-nav, main-admin-
// training-*.ejs instead of admin-training-*.ejs) are new - the handler
// bodies below are the literal same calls as routes/admin-training.js,
// just redirecting to /main-admin/training/... instead of /admin/
// training/....
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const T = require('../utils/training');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_training'));

function backToBuilder(res, trainingId, extra) {
  const qs = extra ? '?' + new URLSearchParams(extra).toString() : '';
  res.redirect(`/main-admin/training/${trainingId}/builder${qs}`);
}

// ---------------------------------------------------------------------
// List / create / publish / archive / delete
// ---------------------------------------------------------------------

router.get('/training', async (req, res) => {
  res.render('main-admin-training-list', {
    title: 'Training',
    trainings: await T.listTrainings(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training', async (req, res) => {
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
    res.redirect(`/main-admin/training/${id}/builder?notice=` + encodeURIComponent('Training created. Add some lessons below.'));
  } catch (e) {
    res.redirect('/main-admin/training?error=' + encodeURIComponent(e.message));
  }
});

router.get('/training/:id/builder', async (req, res) => {
  const training = await T.getTrainingWithContent(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-training-builder', {
    title: training.title,
    training,
    LESSON_TYPES: T.LESSON_TYPES,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training/:id/update', async (req, res) => {
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

router.post('/training/:id/status', async (req, res) => {
  const id = req.params.id;
  try {
    await T.setTrainingStatus(id, req.body.status);
    const label = req.body.status === 'published' ? 'Training published.' : req.body.status === 'archived' ? 'Training archived.' : 'Training moved back to draft.';
    backToBuilder(res, id, { notice: label });
  } catch (e) {
    backToBuilder(res, id, { error: e.message });
  }
});

router.post('/training/:id/delete', async (req, res) => {
  const ok = await T.deleteTraining(req.params.id);
  if (ok) return res.redirect('/main-admin/training?notice=' + encodeURIComponent('Training deleted.'));
  backToBuilder(res, req.params.id, { error: 'Only a draft training with no assignments can be deleted - Archive it instead.' });
});

// ---------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------

router.post('/training/:id/lessons', async (req, res) => {
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

router.post('/training/:id/lessons/:lessonId/update', async (req, res) => {
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

router.post('/training/:id/lessons/:lessonId/delete', async (req, res) => {
  await T.deleteLesson(req.params.lessonId);
  backToBuilder(res, req.params.id, { notice: 'Lesson removed.' });
});

router.post('/training/:id/lessons/:lessonId/move', async (req, res) => {
  await T.moveLesson(req.params.lessonId, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect(`/main-admin/training/${req.params.id}/builder`);
});

// Resource images - same shared upload backend routes/admin-training.js
// already uses (utils/uploadBackend.js's saveUpload/removeUpload against
// the same 'training-resources' bucket/local dir) - an image uploaded
// from either portal's builder lives in the exact same place.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { imageFileFilter } = require('../utils/uploads');
const { saveUpload, removeUpload } = require('../utils/uploadBackend');
const { createStorageClient } = require('../utils/storage');

const RESOURCE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'training');
const RESOURCE_BUCKET = 'training-resources';
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(RESOURCE_DIR)) fs.mkdirSync(RESOURCE_DIR, { recursive: true });
const uploadResource = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });

router.post('/training/:id/lessons/:lessonId/resources', uploadResource.single('file'), async (req, res) => {
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

router.post('/training/:id/lessons/:lessonId/resources/:resourceId/delete', async (req, res) => {
  const filePath = await T.deleteLessonResource(req.params.resourceId);
  if (filePath) await removeUpload({ client: storageClient, bucket: RESOURCE_BUCKET, localDir: RESOURCE_DIR, key: filePath });
  backToBuilder(res, req.params.id, { notice: 'Image removed.' });
});

// ---------------------------------------------------------------------
// Quiz questions
// ---------------------------------------------------------------------

// Same option-parsing shape as routes/admin-training.js's own
// optionsFromBody - see that file's own comment on why multiple-choice's
// one-correct-answer shape is what future question types would each
// need their own validation for.
function optionsFromBody(body) {
  const texts = [].concat(body.optionText || []);
  const correctIndex = parseInt(body.correctIndex, 10);
  return texts.map((text, i) => ({ text, correct: i === correctIndex }));
}

router.post('/training/:id/lessons/:lessonId/questions', async (req, res) => {
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

router.post('/training/:id/lessons/:lessonId/questions/:questionId/update', async (req, res) => {
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

router.post('/training/:id/lessons/:lessonId/questions/:questionId/delete', async (req, res) => {
  await T.deleteQuizQuestion(req.params.questionId);
  backToBuilder(res, req.params.id, { notice: 'Question removed.' });
});

router.post('/training/:id/lessons/:lessonId/questions/:questionId/move', async (req, res) => {
  await T.moveQuizQuestion(req.params.questionId, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect(`/main-admin/training/${req.params.id}/builder`);
});

// ---------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------

router.get('/training/:id/assign', async (req, res) => {
  const training = await T.getTraining(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-training-assign', {
    title: `Assign - ${training.title}`,
    training,
    members: await T.activeAssignableMembers(),
    alreadyAssigned: new Set((await T.assignmentsForTraining(training.id)).map((a) => a.member_id)),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training/:id/assign', async (req, res) => {
  const id = req.params.id;
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  if (!memberIds.length) {
    return res.redirect(`/main-admin/training/${id}/assign?error=` + encodeURIComponent('Select at least one member.'));
  }
  const dueAt = req.body.dueAt && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueAt) ? req.body.dueAt : null;
  const count = await T.assignTrainingToMembers(id, memberIds, dueAt);
  res.redirect(`/main-admin/training/${id}/report?notice=` + encodeURIComponent(`Assigned to ${count} member(s).`));
});

router.post('/training/:id/assignments/:assignmentId/remove', async (req, res) => {
  await T.removeAssignment(req.params.assignmentId);
  res.redirect(`/main-admin/training/${req.params.id}/report?notice=` + encodeURIComponent('Assignment removed.'));
});

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

router.get('/training/:id/report', async (req, res) => {
  const training = await T.getTraining(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-training-report', {
    title: `Report - ${training.title}`,
    training,
    rows: await T.assignmentsForTraining(training.id),
    notice: req.query.notice || null,
  });
});

router.get('/training/:id/assignments/:assignmentId', async (req, res) => {
  const training = await T.getTraining(req.params.id);
  const detail = await T.assignmentDetail(req.params.assignmentId);
  if (!training || !detail || detail.training_id !== training.id) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-training-assignment-detail', { title: `${detail.memberName} - ${training.title}`, training, detail });
});

module.exports = router;
