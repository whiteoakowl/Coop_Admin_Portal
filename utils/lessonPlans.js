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

async function updateLessonPlan(id, { title, description, gradeLevel, subject, shareableWithParents }) {
  await db
    .prepare('UPDATE lesson_plans SET title = ?, description = ?, grade_level = ?, subject = ?, shareable_with_parents = ?, updated_at = now_text() WHERE id = ?')
    .run(title, description || null, gradeLevel || null, subject || null, shareableWithParents ? 1 : 0, id);
}

// A real request: "Family school management portal, family classes.
// Add a subpage called available lesson plans. Any lesson plans that
// admin has created and marked shareable with parent portal will show
// here as cards." gradeLevels/subjects (both optional arrays) are the
// Filter button's own multi-select checkboxes - an empty/omitted array
// means "no filter on that dimension," never "match nothing."
async function listShareableLessonPlans({ gradeLevels, subjects } = {}) {
  const conditions = ['shareable_with_parents = true'];
  const params = [];
  if (gradeLevels && gradeLevels.length > 0) {
    conditions.push(`grade_level IN (${gradeLevels.map(() => '?').join(',')})`);
    params.push(...gradeLevels);
  }
  if (subjects && subjects.length > 0) {
    conditions.push(`subject IN (${subjects.map(() => '?').join(',')})`);
    params.push(...subjects);
  }
  return db.prepare(`SELECT * FROM lesson_plans WHERE ${conditions.join(' AND ')} ORDER BY title`).all(...params);
}

// Distinct subjects among shareable plans only - the Subject filter's
// own checkbox options should never offer a value that would currently
// filter the catalog down to nothing.
async function listShareableSubjects() {
  const rows = await db.prepare("SELECT DISTINCT subject FROM lesson_plans WHERE shareable_with_parents = true AND subject IS NOT NULL AND subject != '' ORDER BY subject").all();
  return rows.map((r) => r.subject);
}

// A real request: "Click this button and the new page allows you
// change lesson plan settings... allow teachers to edit/add to the
// lesson plan, all members to edit/add to the lesson plan." Saved
// separately from updateLessonPlan above (title/description, the
// Manage page's own edit form) - the Settings page's own two checkboxes
// are the only things this touches.
async function updateLessonPlanSettings(id, { allowTeacherEdit, allowMemberEdit }) {
  await db.prepare('UPDATE lesson_plans SET allow_teacher_edit = ?, allow_member_edit = ?, updated_at = now_text() WHERE id = ?').run(allowTeacherEdit ? 1 : 0, allowMemberEdit ? 1 : 0, id);
}

// A real request: "Lesson plan so that if a teacher uses it for co-op
// classes or a parent uses it for a family school management lesson
// plan for their students they won't be able to change it. It can be
// locked or unlocked by admin." The one shared lookup every non-admin
// enforcement point calls, instead of each route file re-querying
// lesson_plans.locked on its own.
//
// Where this is actually checked today:
//   - Family School Management (routes/parent-family-school.js, via
//     utils/familySchool.js's own contentItemsForLesson/getLesson call
//     sites) - a parent's lesson that references a plan always renders
//     that plan's content read-only, independent of this flag (there is
//     no route that would ever let a parent write to lesson_plan_
//     content_items at all - it's a live read-through reference, never
//     a copy, see the family_school_lesson_plan_reference migration's
//     own comment). The lock state still shows there, so a parent can
//     see whether the admin considers it final.
//   - Co-op Teacher Portal (routes/teacher-portal.js) - deliberately NOT
//     checked here. "Assign to Class" (this file's own
//     assignLessonPlanToClass) is a one-time DEEP COPY into ordinary
//     class_assignments/lesson_content_items rows with no lesson_plan_id
//     of their own at all - by the time a teacher could edit anything,
//     it's already a fully independent row, not "this lesson plan's
//     content" anymore. There is currently no path where a teacher ever
//     edits a lesson_plans/lesson_plan_content_items row directly (only
//     routes/admin-lesson-plans.js touches those, and that whole router
//     is already admin-gated), so there is nothing for `locked` to block
//     on the teacher side today.
async function isLessonPlanLocked(id) {
  if (!id) return false;
  const plan = await db.prepare('SELECT locked FROM lesson_plans WHERE id = ?').get(id);
  return !!(plan && plan.locked);
}

// Admin-only (routes/admin-lesson-plans.js is already fully admin-gated)
// - a plain toggle, same "flip the boolean, hand back the new value for
// the redirect notice" shape familySchool.js's own toggleWeekAssignmentComplete
// already uses.
async function toggleLessonPlanLocked(id) {
  const row = await db.prepare('UPDATE lesson_plans SET locked = NOT locked, updated_at = now_text() WHERE id = ? RETURNING locked').get(id);
  return row ? row.locked : null;
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
      return { ...q, choices: includeAnswerKey ? choices : choices.map(({ is_correct: _is_correct, ...c }) => c) };
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
  listShareableLessonPlans,
  listShareableSubjects,
  getLessonPlan,
  createLessonPlan,
  updateLessonPlan,
  updateLessonPlanSettings,
  deleteLessonPlan,
  isLessonPlanLocked,
  toggleLessonPlanLocked,
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
