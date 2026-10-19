// Lesson Plans - reusable, standalone templates of the same shape a real
// class's own Lessons already are (class_assignments/lesson_content_items/
// quiz_questions/quiz_choices, see utils/academics.js). A real request:
// "Co-op admin portal add a tab called lesson plans... Admins can create
// lessons plans and assign them to a class to be used as an option.
// Teachers can also still create their own lesson plans like they do
// now. Once the admin created lesson plan is added to a class it can
// then be edited by the teacher without changing the main copy admins
// have on their end." assignLessonPlanToClass below is the one function
// that ever bridges a template over to a real class - a one-time deep
// copy into real class_assignments/lesson_content_items/quiz_questions/
// quiz_choices rows, after which the copy is a completely ordinary
// lesson (editable/deletable exactly like a teacher's own) with no
// ongoing link back to the template at all.
const db = require('../db');
const { createAssignment, createContentItem, createQuizQuestion, lessonAttachmentUrl } = require('./academics');
const { getClass } = require('./classSchedule');

async function listLessonPlans() {
  return db.prepare('SELECT * FROM lesson_plans ORDER BY title').all();
}

async function getLessonPlan(id) {
  return db.prepare('SELECT * FROM lesson_plans WHERE id = ?').get(id);
}

async function createLessonPlan({ title, description, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO lesson_plans (title, description, created_by_account_id) VALUES (?, ?, ?)')
    .run(title, description || null, createdByAccountId || null);
  return info.lastInsertRowid;
}

async function updateLessonPlan(id, { title, description }) {
  await db.prepare("UPDATE lesson_plans SET title = ?, description = ?, updated_at = now_text() WHERE id = ?").run(title, description || null, id);
}

// lesson_plan_content_items/lesson_plan_quiz_questions/lesson_plan_quiz_choices
// all cascade off lesson_plans, so one delete here is enough - same
// pattern utils/academics.js's own deleteAssignment comment explains.
async function deleteLessonPlan(id) {
  await db.prepare('DELETE FROM lesson_plans WHERE id = ?').run(id);
}

async function getLessonPlanContentItem(id) {
  return db.prepare('SELECT * FROM lesson_plan_content_items WHERE id = ?').get(id);
}

// includeAnswerKey - same reasoning as contentItemsForAssignment's own
// comment (utils/academics.js): true only for the admin's own editing
// view, never anywhere a non-admin could read the response.
async function contentItemsForLessonPlan(lessonPlanId, { includeAnswerKey = false } = {}) {
  const items = await db.prepare('SELECT * FROM lesson_plan_content_items WHERE lesson_plan_id = ? ORDER BY position, id').all(lessonPlanId);
  return Promise.all(
    items.map(async (item) => {
      const withAttachment = { ...item, attachmentUrl: lessonAttachmentUrl(item.attachment_url) };
      if (withAttachment.type !== 'quiz') return withAttachment;
      return { ...withAttachment, questions: await questionsForLessonPlanContentItem(item.id, { includeAnswerKey }) };
    })
  );
}

// No dueDate here (unlike createContentItem) - see the migration's own
// comment on why a due date only ever makes sense once a copy is
// attached to a real class.
async function createLessonPlanContentItem({ lessonPlanId, type, title, videoUrl, body, fileUrl, description, attachmentUrl, attachmentName, pointsPossible }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM lesson_plan_content_items WHERE lesson_plan_id = ?')
    .get(lessonPlanId);
  const info = await db
    .prepare(
      'INSERT INTO lesson_plan_content_items (lesson_plan_id, type, position, title, video_url, body, file_url, description, attachment_url, attachment_name, points_possible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(lessonPlanId, type, nextPosition, title || null, videoUrl || null, body || null, fileUrl || null, description || null, attachmentUrl || null, attachmentName || null, pointsPossible != null ? pointsPossible : null);
  return info.lastInsertRowid;
}

async function updateLessonPlanContentItem(id, { title, videoUrl, body, fileUrl, description, attachmentUrl, attachmentName, pointsPossible }) {
  await db
    .prepare(
      'UPDATE lesson_plan_content_items SET title = ?, video_url = ?, body = ?, file_url = ?, description = ?, attachment_url = ?, attachment_name = ?, points_possible = ? WHERE id = ?'
    )
    .run(
      title || null,
      videoUrl || null,
      body || null,
      fileUrl || null,
      description || null,
      attachmentUrl || null,
      attachmentName || null,
      pointsPossible != null ? pointsPossible : null,
      id
    );
}

async function deleteLessonPlanContentItem(id) {
  await db.prepare('DELETE FROM lesson_plan_content_items WHERE id = ?').run(id);
}

async function reorderLessonPlanContentItems(lessonPlanId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE lesson_plan_content_items SET position = ? WHERE id = ? AND lesson_plan_id = ?').run(i, orderedIds[i], lessonPlanId);
  }
}

async function questionsForLessonPlanContentItem(contentItemId, { includeAnswerKey = false } = {}) {
  const questions = await db.prepare('SELECT * FROM lesson_plan_quiz_questions WHERE content_item_id = ? ORDER BY position, id').all(contentItemId);
  return Promise.all(
    questions.map(async (q) => {
      if (q.type !== 'multiple_choice') return { ...q, choices: [] };
      const choices = await db.prepare('SELECT * FROM lesson_plan_quiz_choices WHERE question_id = ? ORDER BY position, id').all(q.id);
      return { ...q, choices: includeAnswerKey ? choices : choices.map(({ is_correct, ...c }) => c) };
    })
  );
}

async function createLessonPlanQuizQuestion({ contentItemId, type, prompt, pointsPossible, choices }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM lesson_plan_quiz_questions WHERE content_item_id = ?')
    .get(contentItemId);
  const info = await db
    .prepare('INSERT INTO lesson_plan_quiz_questions (content_item_id, type, prompt, points_possible, position) VALUES (?, ?, ?, ?, ?)')
    .run(contentItemId, type, prompt, pointsPossible || 1, nextPosition);
  const questionId = info.lastInsertRowid;
  if (type === 'multiple_choice') {
    let position = 0;
    for (const choice of choices || []) {
      if (!choice.label || !choice.label.trim()) continue;
      await db
        .prepare('INSERT INTO lesson_plan_quiz_choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)')
        .run(questionId, choice.label.trim(), choice.isCorrect ? 1 : 0, position++);
    }
  }
  return questionId;
}

async function deleteLessonPlanQuizQuestion(id) {
  await db.prepare('DELETE FROM lesson_plan_quiz_questions WHERE id = ?').run(id);
}

// The one bridge from a template to a real class - "essentially its like
// adding a ready made lesson plan template to a class, the teacher can
// tweak it without changing the original." Builds a brand new
// class_assignments row (same createAssignment every other "add a lesson
// to a class" path uses) titled after the lesson plan, then deep-copies
// every content item (and, for a quiz, every question/choice) onto it -
// an ordinary, fully independent lesson from this point on. Returns the
// new assignment's id so the caller can redirect straight to it.
async function assignLessonPlanToClass(lessonPlanId, classId, createdByAccountId) {
  const plan = await getLessonPlan(lessonPlanId);
  if (!plan) throw new Error('Lesson plan not found.');
  const cls = await getClass(classId);
  if (!cls) throw new Error('Class not found.');

  const assignmentId = await createAssignment({
    classId,
    className: cls.class_name,
    title: plan.title,
    description: plan.description,
    createdByAccountId,
  });

  const items = await contentItemsForLessonPlan(lessonPlanId, { includeAnswerKey: true });
  for (const item of items) {
    const newItemId = await createContentItem({
      assignmentId,
      type: item.type,
      title: item.title,
      videoUrl: item.video_url,
      body: item.body,
      fileUrl: item.file_url,
      description: item.description,
      attachmentUrl: item.attachment_url,
      attachmentName: item.attachment_name,
      pointsPossible: item.points_possible,
    });
    if (item.type === 'quiz') {
      for (const q of item.questions) {
        await createQuizQuestion({
          contentItemId: newItemId,
          type: q.type,
          prompt: q.prompt,
          pointsPossible: q.points_possible,
          choices: q.choices.map((c) => ({ label: c.label, isCorrect: !!c.is_correct })),
        });
      }
    }
  }

  return assignmentId;
}

module.exports = {
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
};
