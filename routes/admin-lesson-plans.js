// Lesson Plans - a real request: "Co-op admin portal add a tab called
// lesson plans. On this page there are the same class settings lesson
// plan settings and features. Admins can create lessons plans and assign
// them to a class to be used as an option. Teachers can also still
// create their own lesson plans like they do now. Once the admin created
// lesson plan is added to a class it can then be edited by the teacher
// without changing the main copy admins have on their end." A reusable
// template library, never tied to any one class - "Assign to Class"
// (POST .../assign below) deep-copies a template into a brand new,
// completely independent class Lesson (see utils/lessonPlans.js's own
// assignLessonPlanToClass). Co-op Teacher Portal's own "Add Assignments" flow
// (routes/teacher-portal.js) is entirely untouched by this file.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const { lessonAttachmentFileFilter } = require('../utils/uploads');
const { saveLessonAttachment } = require('../utils/academics');
const { allClassesList } = require('../utils/classSchedule');
const {
  listLessonPlans,
  getLessonPlan,
  createLessonPlan,
  updateLessonPlan,
  deleteLessonPlan,
  getLessonPlanContentItem,
  contentItemsForLessonPlan,
  createLessonPlanContentItem,
  updateLessonPlanContentItem,
  deleteLessonPlanContentItem,
  reorderLessonPlanContentItems,
  questionsForLessonPlanContentItem,
  createLessonPlanQuizQuestion,
  deleteLessonPlanQuizQuestion,
  assignLessonPlanToClass,
  toggleLessonPlanLocked,
} = require('../utils/lessonPlans');

router.use(requireFullAdmin);

router.get('/lesson-plans', async (req, res) => {
  res.render('admin-lesson-plans-list', {
    title: 'Lesson Plans',
    lessonPlans: await listLessonPlans(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/lesson-plans', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/admin/lesson-plans?error=' + encodeURIComponent('A title is required.'));
  const id = await createLessonPlan({ title, description: (req.body.description || '').trim(), createdByAccountId: null });
  res.redirect(`/admin/lesson-plans/${id}?notice=` + encodeURIComponent('Lesson plan created.'));
});

router.post('/lesson-plans/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(id);
  if (!plan) return res.status(404).send('Not found');
  await deleteLessonPlan(id);
  res.redirect('/admin/lesson-plans?notice=' + encodeURIComponent(`Deleted "${plan.title}".`));
});

router.get('/lesson-plans/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(id);
  if (!plan) return res.status(404).send('Not found');
  const contentItems = (await contentItemsForLessonPlan(id, { includeAnswerKey: true })).map((item) => item);
  res.render('admin-lesson-plan-manage', {
    title: plan.title,
    plan,
    contentItems,
    classes: await allClassesList(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/lesson-plans/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(id);
  if (!plan) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/admin/lesson-plans/${id}?error=` + encodeURIComponent('A title is required.'));
  await updateLessonPlan(id, { title, description: (req.body.description || '').trim() });
  res.redirect(`/admin/lesson-plans/${id}?notice=` + encodeURIComponent('Lesson plan updated.'));
});

// A real request: "It can be locked or unlocked by admin." Plain toggle
// - see utils/lessonPlans.js's own isLessonPlanLocked for exactly where
// (and where not) the resulting flag is actually enforced.
router.post('/lesson-plans/:id/lock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(id);
  if (!plan) return res.status(404).send('Not found');
  const locked = await toggleLessonPlanLocked(id);
  res.redirect(`/admin/lesson-plans/${id}?notice=` + encodeURIComponent(locked ? 'Lesson plan locked.' : 'Lesson plan unlocked.'));
});

// "Admins can create lessons plans and assign them to a class to be used
// as an option" - the one-time deep copy. Redirects straight to the new
// real Lesson on that class (the Co-op Admin side of it - a teacher on
// that class sees their own portal's identical copy, same as any other
// lesson), per "it can then be edited by the teacher without changing
// the main copy."
router.post('/lesson-plans/:id/assign', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(id);
  if (!plan) return res.status(404).send('Not found');
  const back = `/admin/lesson-plans/${id}`;
  const classId = parseInt(req.body.classId, 10);
  if (!classId) return res.redirect(back + '?error=' + encodeURIComponent('Choose a class to assign this lesson plan to.'));
  let assignmentId;
  try {
    assignmentId = await assignLessonPlanToClass(id, classId, null);
  } catch (err) {
    return res.redirect(back + '?error=' + encodeURIComponent(err.message));
  }
  res.redirect(`/admin/class-schedule/assignments/${assignmentId}?notice=` + encodeURIComponent(`Added "${plan.title}" as a new lesson.`));
});

// --- Content items (mirrors routes/admin-class-schedule.js's own
// /class-schedule/assignments/:id/content routes field-for-field, just
// targeting the lesson_plan_* tables instead - see utils/lessonPlans.js's
// own header comment on why this is a parallel set, not a shared one,
// matching this codebase's own established per-portal duplication
// convention (teacher-portal.js already keeps its own identical copy of
// the class version these are modeled on). ---

const MAX_LESSON_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const lessonAttachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LESSON_ATTACHMENT_BYTES }, fileFilter: lessonAttachmentFileFilter });
function uploadLessonAttachment(req, res, next) {
  lessonAttachmentUpload.single('attachment')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect(
        `/admin/lesson-plans/${req.params.id}?error=` +
          encodeURIComponent(`That file is too large - lesson plan attachments are limited to ${MAX_LESSON_ATTACHMENT_BYTES / (1024 * 1024)}MB.`)
      );
    }
    next(err);
  });
}

const LESSON_CONTENT_TYPES = ['video', 'text', 'file', 'quiz', 'assignment_upload', 'assignment_submission'];

router.post('/lesson-plans/:id/content', uploadLessonAttachment, async (req, res) => {
  const lessonPlanId = parseInt(req.params.id, 10);
  const plan = await getLessonPlan(lessonPlanId);
  if (!plan) return res.status(404).send('Not found');
  const back = `/admin/lesson-plans/${lessonPlanId}`;
  const type = req.body.type;
  if (!LESSON_CONTENT_TYPES.includes(type)) return res.redirect(back + '?error=' + encodeURIComponent('Choose a content type.'));

  let attachmentUrl = null;
  let attachmentName = null;
  if (type === 'assignment_upload' && req.file) {
    attachmentUrl = await saveLessonAttachment(req.file);
    attachmentName = req.file.originalname;
  }

  await createLessonPlanContentItem({
    lessonPlanId,
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
    attachmentUrl,
    attachmentName,
    pointsPossible: type === 'assignment_submission' && req.body.submissionPointsPossible ? parseInt(req.body.submissionPointsPossible, 10) : null,
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Added to the lesson plan.'));
});

router.post('/lesson-plans/content/:id/edit', uploadLessonAttachment, async (req, res) => {
  const contentItem = await getLessonPlanContentItem(parseInt(req.params.id, 10));
  if (!contentItem) return res.status(404).send('Not found');
  const back = `/admin/lesson-plans/${contentItem.lesson_plan_id}`;
  const type = contentItem.type;

  let attachmentUrl = contentItem.attachment_url;
  let attachmentName = contentItem.attachment_name;
  if (type === 'assignment_upload' && req.file) {
    attachmentUrl = await saveLessonAttachment(req.file);
    attachmentName = req.file.originalname;
  }

  await updateLessonPlanContentItem(contentItem.id, {
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
    attachmentUrl,
    attachmentName,
    pointsPossible: type === 'assignment_submission' && req.body.submissionPointsPossible ? parseInt(req.body.submissionPointsPossible, 10) : null,
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Updated.'));
});

router.post('/lesson-plans/content/:id/delete', async (req, res) => {
  const contentItem = await getLessonPlanContentItem(parseInt(req.params.id, 10));
  if (!contentItem) return res.status(404).send('Not found');
  await deleteLessonPlanContentItem(contentItem.id);
  res.redirect(`/admin/lesson-plans/${contentItem.lesson_plan_id}?notice=` + encodeURIComponent('Removed.'));
});

router.post('/lesson-plans/:id/content/reorder', async (req, res) => {
  const lessonPlanId = parseInt(req.params.id, 10);
  const contentItemIds = [].concat(req.body.contentItemIds || []).map((v) => parseInt(v, 10));
  await reorderLessonPlanContentItems(lessonPlanId, contentItemIds);
  res.json({ ok: true });
});

// --- Quiz questions (mirrors routes/admin-class-schedule.js's own
// /class-schedule/content/:id/questions routes). ---

router.get('/lesson-plans/content/:id/questions', async (req, res) => {
  const contentItem = await getLessonPlanContentItem(parseInt(req.params.id, 10));
  if (!contentItem || contentItem.type !== 'quiz') return res.status(404).send('Not found');
  const plan = await getLessonPlan(contentItem.lesson_plan_id);
  const items = await contentItemsForLessonPlan(plan.id, { includeAnswerKey: true });
  const questions = items.find((i) => i.id === contentItem.id).questions;
  res.render('admin-lesson-plan-quiz-questions', {
    title: `Questions - ${contentItem.title || 'Quiz'}`,
    basePath: '/admin/lesson-plans',
    plan,
    contentItem,
    questions,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/lesson-plans/content/:id/questions', async (req, res) => {
  const contentItem = await getLessonPlanContentItem(parseInt(req.params.id, 10));
  if (!contentItem) return res.status(404).send('Not found');
  const back = `/admin/lesson-plans/${contentItem.lesson_plan_id}`;
  const type = req.body.type === 'short_answer' ? 'short_answer' : 'multiple_choice';
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.redirect(back + '?error=' + encodeURIComponent('A question prompt is required.'));
  const correctIndex = req.body.correctChoice;
  const choices = [1, 2, 3, 4].map((n) => ({
    label: (req.body[`choice${n}`] || '').trim(),
    isCorrect: String(correctIndex) === String(n),
  }));
  await createLessonPlanQuizQuestion({
    contentItemId: contentItem.id,
    type,
    prompt,
    pointsPossible: req.body.pointsPossible ? Number(req.body.pointsPossible) : 1,
    choices: type === 'multiple_choice' ? choices : [],
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Question added.'));
});

router.post('/lesson-plans/questions/:id/delete', async (req, res) => {
  const questionId = parseInt(req.params.id, 10);
  const question = await db
    .prepare('SELECT q.*, lpci.lesson_plan_id FROM lesson_plan_quiz_questions q JOIN lesson_plan_content_items lpci ON lpci.id = q.content_item_id WHERE q.id = ?')
    .get(questionId);
  if (!question) return res.status(404).send('Not found');
  await deleteLessonPlanQuizQuestion(questionId);
  res.redirect(`/admin/lesson-plans/${question.lesson_plan_id}?notice=` + encodeURIComponent('Question removed.'));
});

module.exports = router;
