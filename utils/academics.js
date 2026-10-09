// Assignments/grading, diplomas, and transcripts - shared by Teacher
// Portal (creating/grading), Student/Parent Portal (viewing), and Main
// Admin (issuing diplomas). See the academic_records migration's own
// header comment for the schema rationale, especially
// student_academic_history's "only written going forward" limitation.
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { formatDateLabel, formatFriendlyTimestamp, todayISO } = require('./dates');
const { lastNameOf } = require('./members');
const { createStorageClient, uploadFile, deleteFile, generateKey, publicUrl } = require('./storage');

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

// A real bug report: "there is no manage or trash button at the end of
// each class assignment in co-op admin portal" - the Lessons tab's own
// delete action didn't exist at all yet. lesson_content_items,
// assignment_grades, and (transitively) quiz_questions/choices/attempts
// and lesson_item_completions all reference class_assignments with
// "on delete cascade" (see the lesson_content_and_quizzes and
// academic_records migrations), so one delete here is enough.
async function deleteAssignment(id) {
  await db.prepare('DELETE FROM class_assignments WHERE id = ?').run(id);
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
// first - most rows come from generateTranscriptsForEndedClasses below
// (automatic, once a class's own end_date passes); the Academics page's
// own "manually add a past term" form writes here directly too, for
// history predating this feature or transfer students.
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

// Automatically backfills a Transcript entry (student_academic_history)
// for every student enrolled in a class whose own end_date has passed -
// the replacement for archiveClasses' old side effect, now that the
// Class Archive feature (and the manual "archive this class" step that
// used to trigger it) has been removed entirely: "everything is
// connected to semesters now, we don't need individual archiving
// anymore." A class simply stays in place once its term ends (no more
// snapshot-then-delete), so this just needs to notice the date has
// passed and backfill, same idea as the other lazy self-heal-on-load
// checks elsewhere in this app. Idempotent via the (student_id, class_id)
// unique index on student_academic_history - a class already backfilled
// on an earlier call is silently skipped, not duplicated, on every later
// one, so this is safe to call on every Academics page load.
async function generateTranscriptsForEndedClasses() {
  const today = todayISO();
  const endedClasses = await db.prepare('SELECT * FROM classes WHERE end_date IS NOT NULL AND end_date < ?').all(today);
  for (const cls of endedClasses) {
    const studentIds = (await db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(cls.id)).map((r) => r.student_id);
    if (studentIds.length === 0) continue;
    const alreadyDone = new Set(
      (await db.prepare('SELECT student_id FROM student_academic_history WHERE class_id = ?').all(cls.id)).map((r) => r.student_id)
    );
    const stillNeeded = studentIds.filter((id) => !alreadyDone.has(id));
    if (stillNeeded.length === 0) continue;
    const teacherNames =
      (
        await db
          .prepare("SELECT m.name FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = ? AND cs.role = 'teacher'")
          .all(cls.id)
      )
        .map((r) => r.name)
        .join(', ') || null;
    for (const studentId of stillNeeded) {
      await db
        .prepare(
          `INSERT INTO student_academic_history (student_id, class_name, day, age_group, teacher_names, term_ended_at, class_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(studentId, cls.class_name, cls.day, cls.age_group, teacherNames, cls.end_date, cls.id);
    }
  }
}

// --- Lesson content items (video/text/file/quiz/assignment_upload) ---
// A real request: "Classes, lessons. Button to add lessons. Could be link
// to video, text description, file link, quiz with scoring... drop down
// of the different links and activities." One lesson (class_assignments)
// can carry several content blocks, each its own row (see the migration's
// own header comment for why - a lesson isn't limited to one of each).

// A later real request: "add a description area [to Link to Video/Link
// to File], an option for assignment upload, text box with word count
// and full editing features, also be able to upload a file such as doc,
// pdf, jpg etc." - assignment_upload's own attachment, shared between
// Co-op Admin's and Teacher Portal's identical Add Assignments form
// (views/partials/lesson-content-manage.ejs), same public-bucket-or-
// local-disk shape utils/classSchedule.js's own CLASS_IMAGES_BUCKET/
// classImageUrl already use for a class's own photo.
const LESSON_ATTACHMENTS_BUCKET = 'lesson-attachments';
const LESSON_ATTACHMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'lesson-attachments');
if (!createStorageClient() && !fs.existsSync(LESSON_ATTACHMENT_DIR)) {
  try {
    fs.mkdirSync(LESSON_ATTACHMENT_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${LESSON_ATTACHMENT_DIR}:`, err.message);
  }
}

function lessonAttachmentUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(LESSON_ATTACHMENTS_BUCKET, key) : `/uploads/lesson-attachments/${key}`;
}

async function saveLessonAttachment(file, existingKey) {
  const client = createStorageClient();
  let key;
  if (client) {
    key = await uploadFile(client, LESSON_ATTACHMENTS_BUCKET, file.buffer, file.originalname, file.mimetype);
  } else {
    key = generateKey(file.originalname);
    fs.writeFileSync(path.join(LESSON_ATTACHMENT_DIR, key), file.buffer);
  }
  if (existingKey) {
    if (client) await deleteFile(client, LESSON_ATTACHMENTS_BUCKET, existingKey);
    else {
      const oldPath = path.join(LESSON_ATTACHMENT_DIR, existingKey);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  return key;
}

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
      const withAttachment = { ...item, attachmentUrl: lessonAttachmentUrl(item.attachment_url) };
      if (withAttachment.type !== 'quiz') return withAttachment;
      return { ...withAttachment, questions: await questionsForContentItem(item.id, { includeAnswerKey }) };
    })
  );
}

// pointsPossible: only ever set for the 'assignment_submission' type - a
// real request: "the lesson itself should not have points. Points can be
// attached to each assignment instead." (every other type passes
// undefined/null here, same as before).
// dueDate: a real request: "Due dates should be on the assignments, not
// on the lesson" - every content item (any type) can carry its own now,
// instead of only the parent lesson having one.
async function createContentItem({ assignmentId, type, title, videoUrl, body, fileUrl, description, attachmentUrl, attachmentName, pointsPossible, dueDate }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM lesson_content_items WHERE assignment_id = ?')
    .get(assignmentId);
  const info = await db
    .prepare(
      'INSERT INTO lesson_content_items (assignment_id, type, position, title, video_url, body, file_url, description, attachment_url, attachment_name, points_possible, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(assignmentId, type, nextPosition, title || null, videoUrl || null, body || null, fileUrl || null, description || null, attachmentUrl || null, attachmentName || null, pointsPossible != null ? pointsPossible : null, dueDate || null);
  return info.lastInsertRowid;
}

// A real bug report: "I have zero way of managing the quizzes or any
// other created assignments" - this function already existed but was
// never called from any route (routes/admin-class-schedule.js and
// routes/teacher-portal.js each imported it, unused), so a content
// item's own title/url/body/due date/points could never be changed once
// added - only deleted and recreated from scratch. attachmentUrl/
// attachmentName are passed through as whatever the caller already has
// (the existing stored one, or a freshly uploaded replacement) rather
// than cleared, since not every edit replaces the file.
async function updateContentItem(id, { title, videoUrl, body, fileUrl, description, attachmentUrl, attachmentName, pointsPossible, dueDate }) {
  await db
    .prepare(
      'UPDATE lesson_content_items SET title = ?, video_url = ?, body = ?, file_url = ?, description = ?, attachment_url = ?, attachment_name = ?, points_possible = ?, due_date = ? WHERE id = ?'
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
      dueDate || null,
      id
    );
}

async function deleteContentItem(id) {
  await db.prepare('DELETE FROM lesson_content_items WHERE id = ?').run(id);
}

// --- Assignment Submission (a real request: "there should be a
// assignment submit option... the student will see an upload link") -
// distinct from the pre-existing 'assignment_upload' type, which is an
// admin/teacher posting materials TO students (read-only on the student
// side). This is the reverse: the student uploads their OWN file back,
// and a teacher/admin reviews it with points + a letter/percentage grade
// + feedback (a real clarification on what "grade" meant here). ---

async function getAssignmentSubmission(contentItemId, studentId) {
  return db.prepare('SELECT * FROM assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(contentItemId, studentId);
}

// Re-uploading replaces the file and resets grading back to 'submitted'
// with every grade field cleared, so a teacher/admin reviewing the queue
// knows this one needs a fresh look rather than showing a stale grade
// against a file that's no longer what was graded.
async function submitAssignment({ contentItemId, studentId, fileUrl, fileName }) {
  await db
    .prepare(
      `INSERT INTO assignment_submissions (content_item_id, student_id, file_url, file_name, submitted_at, status, points_earned, grade_letter, feedback, graded_at)
       VALUES (?, ?, ?, ?, now(), 'submitted', NULL, NULL, NULL, NULL)
       ON CONFLICT (content_item_id, student_id) DO UPDATE SET
         file_url = excluded.file_url, file_name = excluded.file_name, submitted_at = now(),
         status = 'submitted', points_earned = NULL, grade_letter = NULL, feedback = NULL, graded_at = NULL`
    )
    .run(contentItemId, studentId, fileUrl, fileName);
}

// Every enrolled student for the content item's own class, left-joined to
// whatever submission (if any) already exists - same "one row per
// student even before they've done anything" shape gradebookForAssignment
// above uses for the whole-lesson gradebook.
async function submissionsForContentItem(contentItemId) {
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem) return null;
  const assignment = await getAssignment(contentItem.assignment_id);
  if (!assignment) return null;
  const rawRows = (
    await db
      .prepare(
        `SELECT m.id AS student_id, m.name AS student_name, s.id AS submission_id, s.file_url, s.file_name, s.submitted_at, s.status, s.points_earned, s.grade_letter, s.feedback
         FROM class_enrollments ce
         JOIN members m ON m.id = ce.student_id
         LEFT JOIN assignment_submissions s ON s.content_item_id = ? AND s.student_id = m.id
         WHERE ce.class_id = ? AND m.active = 1`
      )
      .all(contentItemId, assignment.class_id)
  ).sort((a, b) => lastNameOf(a.student_name).localeCompare(lastNameOf(b.student_name), undefined, { sensitivity: 'base' }) || a.student_name.localeCompare(b.student_name, undefined, { sensitivity: 'base' }));
  // file_url in the DB is actually the storage KEY (same convention
  // lesson_content_items.attachment_url already uses) - resolved to a
  // real URL here the same way lessonAttachmentUrl() does for that column.
  const rows = rawRows.map((r) => ({ ...r, fileUrl: lessonAttachmentUrl(r.file_url) }));
  return { contentItem, assignment, rows };
}

async function gradeAssignmentSubmission({ contentItemId, studentId, pointsEarned, gradeLetter, feedback }) {
  await db
    .prepare(
      `UPDATE assignment_submissions SET status = 'graded', points_earned = ?, grade_letter = ?, feedback = ?, graded_at = now()
       WHERE content_item_id = ? AND student_id = ?`
    )
    .run(pointsEarned != null ? pointsEarned : null, gradeLetter || null, feedback || null, contentItemId, studentId);
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

// A real request: "Student and parent portal you can't click on class
// lessons to complete them." A quiz content item is "completed" by
// submitting it (quiz_attempts above) - a video/text/file item had no
// equivalent action at all, nothing to click. This is that same "Mark
// Complete" click for every other content type, recorded in its own
// table (lesson_item_completions) rather than quiz_attempts since there's
// no attempt/score data to go with it, just a timestamp.
async function getLessonItemCompletion(contentItemId, studentId) {
  return db.prepare('SELECT * FROM lesson_item_completions WHERE content_item_id = ? AND student_id = ?').get(contentItemId, studentId);
}

async function markLessonItemComplete(contentItemId, studentId) {
  await db
    .prepare(
      `INSERT INTO lesson_item_completions (content_item_id, student_id) VALUES (?, ?)
       ON CONFLICT (content_item_id, student_id) DO NOTHING`
    )
    .run(contentItemId, studentId);
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
  const lessons = await Promise.all(
    assignments.map(async (a) => {
      const isOpen = !a.open_date || a.open_date <= today;
      const contentItems = isOpen ? await contentItemsForAssignment(a.id, { includeAnswerKey: false }) : [];
      // A real request: "Due dates should be on the assignments, not on
      // the lesson" - each content item ("assignment" in the Parent/
      // Student portal's own wording) carries its own due_date now, not
      // just the parent lesson. "Marking complete on an assignment...
      // Each lesson should be a bar... shows number of assignments. As
      // you mark assignments complete the lesson bar shows 1/5" - a quiz
      // counts done once attempted (its own existing semantics - see
      // lessons-view.ejs's own quiz branch), an Assignment Submission
      // counts done once the student has uploaded a file (that upload IS
      // the completion action for this type), everything else via the
      // pre-existing Mark Complete click.
      const withAttempts = await Promise.all(
        contentItems.map(async (item) => {
          const dueDateLabel = item.due_date ? formatDateLabel(item.due_date) : null;
          if (item.type === 'quiz') {
            const attempt = await getQuizAttempt(item.id, studentId);
            return { ...item, dueDateLabel, attempt: attempt || null, completed: !!attempt };
          }
          if (item.type === 'assignment_submission') {
            const submission = await getAssignmentSubmission(item.id, studentId);
            return { ...item, dueDateLabel, submission: submission || null, completed: !!submission };
          }
          const completion = await getLessonItemCompletion(item.id, studentId);
          return { ...item, dueDateLabel, completed: !!completion };
        })
      );
      const completedCount = withAttempts.filter((item) => item.completed).length;
      return { ...a, isOpen, contentItems: withAttempts, completedCount, totalCount: withAttempts.length };
    })
  );
  // A real request: "If no dates are added, it still won't let you go to
  // the next lesson until the first one is complete" - lessons must be
  // worked in order regardless of whether open_date gating alone would
  // already separate them. A lesson with no content (totalCount === 0,
  // including one that isn't open yet) can't be "completed" by the
  // student, so it's treated as satisfied for this purpose rather than
  // permanently blocking every lesson after it. Skipped entirely in the
  // generic/no-student review mode (studentId null - Parent Portal's own
  // ?viewer=parent-<id> staff mode, which isn't tracking any one
  // student's progress to sequence against) so that read-only view keeps
  // showing every lesson's content, same as before this feature existed.
  if (!studentId) return lessons.map((lesson) => ({ ...lesson, locked: false }));
  let previousComplete = true;
  return lessons.map((lesson) => {
    const locked = !lesson.isOpen || !previousComplete;
    previousComplete = lesson.isOpen && (lesson.totalCount === 0 || lesson.completedCount === lesson.totalCount);
    return { ...lesson, locked };
  });
}

// Whether a lesson is currently off-limits to a given student - the same
// combined open_date + "previous lesson complete" gate lessonsForStudentView
// computes for the Lessons tab, reused by the content-item routes below so
// a student/parent can't bypass "complete lessons in order" by just
// visiting a content item's URL directly once it's no longer the one at
// the front of the line.
async function isLessonLockedForStudent(classId, studentId, assignmentId) {
  const lessons = await lessonsForStudentView(classId, studentId);
  const lesson = lessons.find((l) => l.id === assignmentId);
  return !lesson || lesson.locked;
}

// A real request: "On lesson list show percentage of how many people in
// the class completed the assignments." A quiz content item counts as
// complete once the student has a quiz_attempts row; every other content
// type (video/text/file/assignment_upload) now has its own "Mark
// Complete" click (lesson_item_completions - see the real request this
// answers: "you can't click on class lessons to complete them", nothing
// was clickable for those types before). A lesson counts as complete for
// one student once EVERY content item in it - quiz or not - is done.
// Returns { [assignmentId]: percent|null } - null for a lesson with no
// content items at all, or a class with no enrolled students, rather
// than a misleading 0%/100%.
async function completionStatsForAssignments(classId) {
  const enrolled = await db
    .prepare(
      `SELECT ce.student_id FROM class_enrollments ce JOIN members m ON m.id = ce.student_id WHERE ce.class_id = ? AND m.active = 1`
    )
    .all(classId);
  const studentIds = enrolled.map((r) => r.student_id);
  const assignments = await assignmentsForClass(classId);
  const stats = {};
  for (const a of assignments) {
    if (studentIds.length === 0) {
      stats[a.id] = null;
      continue;
    }
    const items = await db.prepare('SELECT id, type FROM lesson_content_items WHERE assignment_id = ?').all(a.id);
    if (items.length === 0) {
      stats[a.id] = null;
      continue;
    }
    const quizIds = items.filter((i) => i.type === 'quiz').map((i) => i.id);
    const otherIds = items.filter((i) => i.type !== 'quiz').map((i) => i.id);
    let completedCount = 0;
    for (const studentId of studentIds) {
      let doneCount = 0;
      if (quizIds.length) {
        const { c } = await db
          .prepare(`SELECT COUNT(*) AS c FROM quiz_attempts WHERE student_id = ? AND content_item_id IN (${quizIds.map(() => '?').join(',')})`)
          .get(studentId, ...quizIds);
        doneCount += Number(c);
      }
      if (otherIds.length) {
        const { c } = await db
          .prepare(
            `SELECT COUNT(*) AS c FROM lesson_item_completions WHERE student_id = ? AND content_item_id IN (${otherIds.map(() => '?').join(',')})`
          )
          .get(studentId, ...otherIds);
        doneCount += Number(c);
      }
      if (doneCount === items.length) completedCount++;
    }
    stats[a.id] = Math.round((completedCount / studentIds.length) * 100);
  }
  return stats;
}

module.exports = {
  assignmentsForClass,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
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
  generateTranscriptsForEndedClasses,
  getContentItem,
  contentItemsForAssignment,
  createContentItem,
  updateContentItem,
  deleteContentItem,
  getAssignmentSubmission,
  submitAssignment,
  submissionsForContentItem,
  gradeAssignmentSubmission,
  reorderContentItems,
  lessonAttachmentUrl,
  saveLessonAttachment,
  completionStatsForAssignments,
  questionsForContentItem,
  createQuizQuestion,
  deleteQuizQuestion,
  getQuizAttempt,
  submitQuizAttempt,
  getLessonItemCompletion,
  markLessonItemComplete,
  pendingReviewAnswers,
  scoreAnswer,
  lessonsForStudentView,
  isLessonLockedForStudent,
};
