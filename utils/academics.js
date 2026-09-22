// Assignments/grading, diplomas, and transcripts - shared by Teacher
// Portal (creating/grading), Student/Parent Portal (viewing), and Main
// Admin (issuing diplomas). See the academic_records migration's own
// header comment for the schema rationale, especially
// student_academic_history's "only written going forward" limitation.
const db = require('../db');
const { formatDateLabel, formatFriendlyTimestamp, todayISO } = require('./dates');
const { lastNameOf } = require('./members');

// Ordered by each lesson's own drag-reordered position (see the lesson
// content/quizzes migration's own backfill) rather than due date now that
// one exists - a lesson with no due date at all no longer needs the old
// "due_date IS NULL, due_date DESC" tiebreak to sort sensibly.
async function assignmentsForClass(classId) {
  return db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY position, due_date IS NULL, due_date DESC, created_at DESC').all(classId);
}

async function getAssignment(id) {
  return db.prepare('SELECT * FROM class_assignments WHERE id = ?').get(id);
}

async function createAssignment({ classId, className, title, description, dueDate, openDate, pointsPossible, createdByAccountId }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM class_assignments WHERE class_id = ?')
    .get(classId);
  const info = await db
    .prepare(
      'INSERT INTO class_assignments (class_id, class_name, title, description, due_date, open_date, points_possible, position, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(classId, className, title, description || null, dueDate || null, openDate || null, pointsPossible || null, nextPosition, createdByAccountId);
  return info.lastInsertRowid;
}

async function updateAssignment(id, { title, description, dueDate, openDate, pointsPossible }) {
  await db
    .prepare('UPDATE class_assignments SET title = ?, description = ?, due_date = ?, open_date = ?, points_possible = ? WHERE id = ?')
    .run(title, description || null, dueDate || null, openDate || null, pointsPossible || null, id);
}

// Drag-and-drop reorder (public/js/lesson-drag-reorder.js) - same
// "trust only the final on-screen order, scoped to one class" shape as
// utils/taskList.js's own section reorder.
async function reorderAssignments(classId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE class_assignments SET position = ? WHERE id = ? AND class_id = ?').run(i + 1, orderedIds[i], classId);
  }
}

// Every enrolled student for the assignment's own class, left-joined to
// whatever grade row (if any) already exists - lets the gradebook render
// one row per student even before anyone's been graded yet.
async function gradebookForAssignment(assignmentId) {
  const assignment = await getAssignment(assignmentId);
  if (!assignment) return null;
  const rows = (
    await db
      .prepare(
        `SELECT m.id AS student_id, m.name AS student_name, ag.points_earned, ag.feedback
         FROM class_enrollments ce
         JOIN members m ON m.id = ce.student_id
         LEFT JOIN assignment_grades ag ON ag.assignment_id = ? AND ag.student_id = m.id
         WHERE ce.class_id = ? AND m.active = 1`
      )
      .all(assignmentId, assignment.class_id)
  ).sort((a, b) => lastNameOf(a.student_name).localeCompare(lastNameOf(b.student_name), undefined, { sensitivity: 'base' }) || a.student_name.localeCompare(b.student_name, undefined, { sensitivity: 'base' }));
  return { assignment, rows };
}

async function saveGrade({ assignmentId, studentId, pointsEarned, feedback, gradedByAccountId }) {
  await db
    .prepare(
      `INSERT INTO assignment_grades (assignment_id, student_id, points_earned, feedback, graded_at, graded_by_account_id)
       VALUES (?, ?, ?, ?, now_text(), ?)
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET points_earned = ?, feedback = ?, graded_at = now_text(), graded_by_account_id = ?`
    )
    .run(assignmentId, studentId, pointsEarned, feedback || null, gradedByAccountId, pointsEarned, feedback || null, gradedByAccountId);
}

// Every assignment for a student: current, ungraded work from a class
// they're still enrolled in, PLUS every assignment they've ever been
// graded on - including ones whose class has since been archived (that's
// why this can't just filter by "currently enrolled class ids" the way
// gradebookForAssignment does; a student's own grade history has to
// outlive the class the same way student_academic_history does). Reads
// class_assignments.class_name directly (a snapshot, not a live join to
// classes) for the same reason.
async function assignmentsForStudent(studentId, currentClassIds) {
  const placeholders = currentClassIds.length ? currentClassIds.map(() => '?').join(',') : 'NULL';
  const rows = await db
    .prepare(
      `SELECT ca.*, ag.points_earned, ag.feedback
       FROM class_assignments ca
       LEFT JOIN assignment_grades ag ON ag.assignment_id = ca.id AND ag.student_id = ?
       WHERE ca.class_id IN (${placeholders})
          OR ca.id IN (SELECT assignment_id FROM assignment_grades WHERE student_id = ?)
       ORDER BY ca.due_date IS NULL, ca.due_date DESC, ca.created_at DESC`
    )
    .all(studentId, ...currentClassIds, studentId);
  return rows.map((r) => ({
    ...r,
    dueDateLabel: r.due_date ? formatDateLabel(r.due_date) : null,
    graded: r.points_earned != null,
  }));
}

// Every assignment for ONE class, joined to this student's own grade (if
// any) for it - unlike assignmentsForStudent above, this is correctly
// scoped to a single class_id and can't pull in an assignment from a
// different class the student happened to be graded on once. Used by the
// Student Portal's own class detail page (routes/student-portal.js) for
// both its Assignments tab (every assignment, graded or not) and its
// Grades tab (the same rows, just rendered filtered to graded ones).
async function assignmentsForStudentInClass(studentId, classId) {
  const rows = await db
    .prepare(
      `SELECT ca.*, ag.points_earned, ag.feedback
       FROM class_assignments ca
       LEFT JOIN assignment_grades ag ON ag.assignment_id = ca.id AND ag.student_id = ?
       WHERE ca.class_id = ?
       ORDER BY ca.due_date IS NULL, ca.due_date DESC, ca.created_at DESC`
    )
    .all(studentId, classId);
  return rows.map((r) => ({
    ...r,
    dueDateLabel: r.due_date ? formatDateLabel(r.due_date) : null,
    graded: r.points_earned != null,
  }));
}

async function diplomaForStudent(studentId) {
  return db.prepare('SELECT * FROM diplomas WHERE student_id = ?').get(studentId);
}

async function allDiplomas() {
  return db
    .prepare(`SELECT d.*, m.name AS student_name FROM diplomas d JOIN members m ON m.id = d.student_id ORDER BY d.issued_date DESC`)
    .all();
}

async function issueDiploma({ studentId, title, issuedDate, bodyText, issuedByAccountId }) {
  await db
    .prepare(
      `INSERT INTO diplomas (student_id, title, issued_date, body_text, issued_by_account_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (student_id) DO UPDATE SET title = ?, issued_date = ?, body_text = ?, issued_by_account_id = ?, created_at = now_text()`
    )
    .run(studentId, title, issuedDate, bodyText || null, issuedByAccountId, title, issuedDate, bodyText || null, issuedByAccountId);
}

// Past-term history (see the migration's own comment on why this only
// covers terms archived after this feature existed) plus, so the page
// reads as a real transcript and not just a history log, this term's
// live enrollments.
async function transcriptForStudent(studentId) {
  const historyRows = await db
    .prepare('SELECT * FROM student_academic_history WHERE student_id = ? ORDER BY term_ended_at DESC').all(studentId);
  const history = historyRows.map((r) => ({ ...r, termEndedLabel: formatFriendlyTimestamp(r.term_ended_at) }));

  const current = await db
    .prepare(
      `SELECT c.class_name, c.day, c.age_group,
              (SELECT string_agg(m.name, ', ') FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = c.id AND cs.role = 'teacher') AS teacher_names
       FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id
       WHERE ce.student_id = ?
       ORDER BY LOWER(c.class_name)`
    )
    .all(studentId);

  return { current, history };
}

// All student_academic_history rows, across every student, newest term
// first - the Academics page's own "manually add a past term" form
// writes here directly (see the migration's header comment: normally
// only archiveClasses ever writes this table; this is the one other,
// admin-driven way a row gets created, for history predating this
// feature or transfer students).
async function allTranscriptEntries() {
  const rows = await db
    .prepare(`SELECT h.*, m.name AS student_name FROM student_academic_history h JOIN members m ON m.id = h.student_id ORDER BY h.term_ended_at DESC`)
    .all();
  return rows.map((r) => ({ ...r, termEndedLabel: formatFriendlyTimestamp(r.term_ended_at) }));
}

async function addTranscriptEntry({ studentId, className, day, ageGroup, teacherNames, termEndedAt }) {
  const info = await db
    .prepare(
      `INSERT INTO student_academic_history (student_id, class_name, day, age_group, teacher_names, term_ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(studentId, className, day || null, ageGroup || null, teacherNames || null, termEndedAt);
  return info.lastInsertRowid;
}

// --- Lesson content items (video/text/file/quiz) ---
// A real request: "Classes, lessons. Button to add lessons. Could be link
// to video, text description, file link, quiz with scoring... drop down
// of the different links and activities." One lesson (class_assignments)
// can carry several content blocks, each its own row (see the migration's
// own header comment for why - a lesson isn't limited to one of each).

async function getContentItem(id) {
  return db.prepare('SELECT * FROM lesson_content_items WHERE id = ?').get(id);
}

// includeAnswerKey=true (Co-op Admin/Teacher editing) attaches each
// question's own choices WITH is_correct; false (Student/Parent viewing
// or quiz-taking) strips is_correct off every choice so a browser
// devtools poke at the page's own JSON/DOM can't leak the answer key.
async function contentItemsForAssignment(assignmentId, { includeAnswerKey = false } = {}) {
  const items = await db.prepare('SELECT * FROM lesson_content_items WHERE assignment_id = ? ORDER BY position, id').all(assignmentId);
  return Promise.all(
    items.map(async (item) => {
      if (item.type !== 'quiz') return item;
      return { ...item, questions: await questionsForContentItem(item.id, { includeAnswerKey }) };
    })
  );
}

async function createContentItem({ assignmentId, type, title, videoUrl, body, fileUrl }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM lesson_content_items WHERE assignment_id = ?')
    .get(assignmentId);
  const info = await db
    .prepare('INSERT INTO lesson_content_items (assignment_id, type, position, title, video_url, body, file_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(assignmentId, type, nextPosition, title || null, videoUrl || null, body || null, fileUrl || null);
  return info.lastInsertRowid;
}

async function updateContentItem(id, { title, videoUrl, body, fileUrl }) {
  await db
    .prepare('UPDATE lesson_content_items SET title = ?, video_url = ?, body = ?, file_url = ? WHERE id = ?')
    .run(title || null, videoUrl || null, body || null, fileUrl || null, id);
}

async function deleteContentItem(id) {
  await db.prepare('DELETE FROM lesson_content_items WHERE id = ?').run(id);
}

async function reorderContentItems(assignmentId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE lesson_content_items SET position = ? WHERE id = ? AND assignment_id = ?').run(i, orderedIds[i], assignmentId);
  }
}

// --- Quiz questions/choices (the 'quiz' content item type's own data) ---

async function questionsForContentItem(contentItemId, { includeAnswerKey = false } = {}) {
  const questions = await db.prepare('SELECT * FROM quiz_questions WHERE content_item_id = ? ORDER BY position, id').all(contentItemId);
  return Promise.all(
    questions.map(async (q) => {
      if (q.type !== 'multiple_choice') return { ...q, choices: [] };
      const choices = await db.prepare('SELECT * FROM quiz_choices WHERE question_id = ? ORDER BY position, id').all(q.id);
      return { ...q, choices: includeAnswerKey ? choices : choices.map(({ is_correct, ...c }) => c) };
    })
  );
}

// choices: array of { label, isCorrect } - only used for a multiple_choice
// question; a short_answer question gets none (see the migration's own
// comment: "a short_answer question has no rows here at all").
async function createQuizQuestion({ contentItemId, type, prompt, pointsPossible, choices }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM quiz_questions WHERE content_item_id = ?')
    .get(contentItemId);
  const info = await db
    .prepare('INSERT INTO quiz_questions (content_item_id, type, prompt, points_possible, position) VALUES (?, ?, ?, ?, ?)')
    .run(contentItemId, type, prompt, pointsPossible || 1, nextPosition);
  const questionId = info.lastInsertRowid;
  if (type === 'multiple_choice') {
    let position = 0;
    for (const choice of choices || []) {
      if (!choice.label || !choice.label.trim()) continue;
      await db
        .prepare('INSERT INTO quiz_choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)')
        .run(questionId, choice.label.trim(), choice.isCorrect ? 1 : 0, position++);
    }
  }
  return questionId;
}

async function deleteQuizQuestion(id) {
  await db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(id);
}

// --- Quiz attempts (student-only submission, per the confirmed access
// model: a parent can view a child's own attempt but never submit one). ---

async function getQuizAttempt(contentItemId, studentId) {
  return db.prepare('SELECT * FROM quiz_attempts WHERE content_item_id = ? AND student_id = ?').get(contentItemId, studentId);
}

// answers: array of { questionId, choiceId?, answerText? }. multiple_choice
// answers auto-score immediately against quiz_choices.is_correct;
// short_answer answers are stored with is_correct/points_earned left null
// until a teacher/admin reviews them (see scoreAnswer below). The whole
// attempt stays 'pending_review' as long as the quiz has ANY short_answer
// question (even one the student left blank) and flips to 'graded' the
// moment every one of them has been scored.
async function submitQuizAttempt({ contentItemId, studentId, answers }) {
  const questions = await db.prepare('SELECT * FROM quiz_questions WHERE content_item_id = ?').all(contentItemId);
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const pointsPossible = questions.reduce((sum, q) => sum + Number(q.points_possible), 0);
  const hasShortAnswer = questions.some((q) => q.type === 'short_answer');

  const info = await db
    .prepare(
      `INSERT INTO quiz_attempts (content_item_id, student_id, status, points_possible)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (content_item_id, student_id) DO UPDATE SET status = ?, points_possible = ?, submitted_at = now_text(), score_points = NULL, graded_at = NULL, graded_by_account_id = NULL
       RETURNING id`
    )
    .get(contentItemId, studentId, hasShortAnswer ? 'pending_review' : 'graded', pointsPossible, hasShortAnswer ? 'pending_review' : 'graded', pointsPossible);
  const attemptId = info.id;
  await db.prepare('DELETE FROM quiz_answers WHERE attempt_id = ?').run(attemptId);

  let scoreSoFar = 0;
  for (const answer of answers || []) {
    const question = questionsById.get(answer.questionId);
    if (!question) continue;
    if (question.type === 'multiple_choice') {
      const choice = answer.choiceId ? await db.prepare('SELECT * FROM quiz_choices WHERE id = ? AND question_id = ?').get(answer.choiceId, question.id) : null;
      const isCorrect = choice ? Number(choice.is_correct) === 1 : false;
      const pointsEarned = isCorrect ? Number(question.points_possible) : 0;
      scoreSoFar += pointsEarned;
      await db
        .prepare('INSERT INTO quiz_answers (attempt_id, question_id, choice_id, is_correct, points_earned) VALUES (?, ?, ?, ?, ?)')
        .run(attemptId, question.id, choice ? choice.id : null, isCorrect ? 1 : 0, pointsEarned);
    } else {
      await db
        .prepare('INSERT INTO quiz_answers (attempt_id, question_id, answer_text, is_correct, points_earned) VALUES (?, ?, ?, NULL, NULL)')
        .run(attemptId, question.id, (answer.answerText || '').trim() || null);
    }
  }

  if (!hasShortAnswer) {
    await db.prepare('UPDATE quiz_attempts SET score_points = ? WHERE id = ?').run(scoreSoFar, attemptId);
  }
  return getQuizAttempt(contentItemId, studentId);
}

// Every short_answer quiz_answers row still awaiting a teacher/admin's
// score, across every class (Co-op Admin) or scoped to one teacher's own
// classes (classIds passed in) - joined all the way out to the student's
// name and the class/lesson/quiz it belongs to so a review queue can
// render without N further lookups.
async function pendingReviewAnswers(classIds) {
  const placeholders = classIds ? classIds.map(() => '?').join(',') : null;
  const rows = await db
    .prepare(
      `SELECT qa.id AS answer_id, qa.attempt_id, qa.answer_text, qq.id AS question_id, qq.prompt, qq.points_possible,
              lci.id AS content_item_id, lci.title AS content_item_title,
              ca.id AS assignment_id, ca.title AS assignment_title, ca.class_id, ca.class_name,
              qat.student_id, m.name AS student_name, qat.submitted_at
       FROM quiz_answers qa
       JOIN quiz_questions qq ON qq.id = qa.question_id
       JOIN quiz_attempts qat ON qat.id = qa.attempt_id
       JOIN lesson_content_items lci ON lci.id = qat.content_item_id
       JOIN class_assignments ca ON ca.id = lci.assignment_id
       JOIN members m ON m.id = qat.student_id
       WHERE qq.type = 'short_answer' AND qa.is_correct IS NULL
       ${placeholders ? `AND ca.class_id IN (${placeholders})` : ''}
       ORDER BY qat.submitted_at`
    )
    .all(...(classIds || []));
  return rows;
}

// Scores one short_answer answer, then recomputes its whole attempt: once
// every short_answer answer in that attempt has a score, the attempt
// flips from 'pending_review' to 'graded' and its score_points becomes
// the sum of every answer's own points_earned (multiple_choice answers
// were already scored at submission).
async function scoreAnswer({ answerId, isCorrect, pointsEarned, gradedByAccountId }) {
  const answer = await db.prepare('SELECT * FROM quiz_answers WHERE id = ?').get(answerId);
  if (!answer) return;
  await db.prepare('UPDATE quiz_answers SET is_correct = ?, points_earned = ? WHERE id = ?').run(isCorrect ? 1 : 0, pointsEarned, answerId);

  const stillPending = await db.prepare('SELECT COUNT(*) AS n FROM quiz_answers WHERE attempt_id = ? AND is_correct IS NULL').get(answer.attempt_id);
  if (Number(stillPending.n) === 0) {
    const { total } = await db.prepare('SELECT COALESCE(SUM(points_earned), 0) AS total FROM quiz_answers WHERE attempt_id = ?').get(answer.attempt_id);
    await db
      .prepare("UPDATE quiz_attempts SET status = 'graded', score_points = ?, graded_at = now_text(), graded_by_account_id = ? WHERE id = ?")
      .run(total, gradedByAccountId, answer.attempt_id);
  }
}

// Every lesson in a class, its own content items (no answer key - see
// contentItemsForAssignment), and - for a quiz item - this one student's
// own attempt (or null), for the Student/Parent Portal's own Lessons tab.
// A lesson whose open_date is still in the future is included (so its
// due date etc. still shows) but flagged isOpen: false so the page can
// hide its content instead of a blank/confusing lesson row; a parent
// passes their child's own studentId and gets the exact same shape back
// - the only difference is which portal renders a "Take Quiz" link at
// all (never Parent Portal, per the confirmed student-only access model).
async function lessonsForStudentView(classId, studentId) {
  const assignments = await assignmentsForClass(classId);
  const today = todayISO();
  return Promise.all(
    assignments.map(async (a) => {
      const isOpen = !a.open_date || a.open_date <= today;
      const contentItems = isOpen ? await contentItemsForAssignment(a.id, { includeAnswerKey: false }) : [];
      const withAttempts = await Promise.all(
        contentItems.map(async (item) => {
          if (item.type !== 'quiz') return item;
          const attempt = await getQuizAttempt(item.id, studentId);
          return { ...item, attempt: attempt || null };
        })
      );
      return { ...a, dueDateLabel: a.due_date ? formatDateLabel(a.due_date) : null, isOpen, contentItems: withAttempts };
    })
  );
}

module.exports = {
  assignmentsForClass,
  getAssignment,
  createAssignment,
  updateAssignment,
  reorderAssignments,
  gradebookForAssignment,
  saveGrade,
  assignmentsForStudent,
  assignmentsForStudentInClass,
  diplomaForStudent,
  allDiplomas,
  issueDiploma,
  transcriptForStudent,
  allTranscriptEntries,
  addTranscriptEntry,
  getContentItem,
  contentItemsForAssignment,
  createContentItem,
  updateContentItem,
  deleteContentItem,
  reorderContentItems,
  questionsForContentItem,
  createQuizQuestion,
  deleteQuizQuestion,
  getQuizAttempt,
  submitQuizAttempt,
  pendingReviewAnswers,
  scoreAnswer,
  lessonsForStudentView,
};
