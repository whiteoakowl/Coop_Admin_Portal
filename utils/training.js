// Training & Learning module - Training Builder (admin), assignment,
// and the member-facing Training Player, all in one place the same way
// utils/setup.js and utils/volunteers.js each own their whole feature.
//
// Architecture notes (see the migration file's own header for the schema
// itself):
//
//   - Training / TrainingAssignment / TrainingAttempt are kept
//     deliberately separate, per the module's own design brief: the
//     Training row never represents any one member's progress - that's
//     what TrainingAssignment (one per member per training) and
//     TrainingAttempt (one per retake) are for. A member can retake a
//     training; a training can have many members assigned; neither
//     relationship is 1:1 with the training definition itself.
//
//   - Lesson progress and quiz answers are keyed to the ATTEMPT, not the
//     assignment. That single choice is what makes "Repeat Entire
//     Training" work for free: starting a new attempt just means fresh,
//     re-locked progress rows for the training's current lesson list,
//     while every earlier attempt's own rows (including its video-watch
//     history and submitted answers) stay exactly as they were,
//     unaffected, for admin reporting and attempt history.
//
//   - No video hosting/streaming infrastructure exists anywhere in this
//     app (see utils/uploads.js/utils/storage.js - image and document
//     uploads only). A video lesson just stores a link - either a direct
//     file URL, played with a plain <video> element (real browser
//     playback, real timeupdate events, no new dependency), or a
//     youtube.com/youtu.be link (a real bug report: pasting one rendered
//     nothing but a black box, since a YouTube page is an HTML document,
//     not a playable video file a <video src> can ever load). youtubeVideoId
//     below is what tells the Training Player (views/training-play.ejs)
//     which of the two to render - a YouTube link gets the YouTube IFrame
//     Player API instead (public/js/training-player.js), polling
//     getCurrentTime()/getDuration() to report progress through the exact
//     same /video-progress endpoint and watch-threshold gate as native
//     <video> playback, since a cross-origin iframe has no timeupdate
//     events of its own to listen for.
//
//   - This app has no per-admin identity (a single shared Admin login -
//     see requireAdmin.js's own comment) and no member login/portal at
//     all (Portal Access was removed sitewide - see git history). Member
//     access here follows the exact same "public link, no password, pick
//     your own name from an admin-curated list" trust model this app
//     already uses everywhere else a member needs to identify themselves
//     without logging in (routes/absence.js, routes/kiosk.js's Class
//     Check-In and Find a Parent) - see routes/training.js's own comment
//     for exactly how that identity is established and protected
//     server-side once picked.
//
//   - Server-authoritative by design: every function here that changes
//     lesson/quiz/attempt state re-derives locking, video-completion, and
//     grading from the database itself, never from a caller-supplied
//     "isComplete"/"score"/"passed" value. routes/training.js's own POST
//     handlers only ever pass through raw inputs (which video timestamp
//     was reached, which option id was picked) - every judgment call
//     (is this lesson unlocked, did they really watch enough, is this
//     answer correct, did they pass) happens in this file, off data
//     scoped to the session-derived assignment id, not the client's own
//     assertions. See each function's own comment for specifics.
const db = require('../db');
const { byLastName, lastNameOf, teacherMemberIds } = require('./members');

const LESSON_TYPES = ['video', 'text', 'quiz'];
const TRAINING_STATUSES = ['draft', 'published', 'archived'];
const ASSIGNMENT_STATUSES = ['not_started', 'in_progress', 'passed', 'failed', 'retry_required', 'expired'];

// Extracts the 11-character video id from any of the URL shapes someone
// is realistically going to paste into a video lesson's Video URL field -
// a plain watch page (with or without other query params like a
// playlist's own ?list=... coming first), a shortened youtu.be link, an
// existing /embed/ or /shorts/ URL, the privacy-enhanced youtube-nocookie.com
// domain, and the www./m. subdomain variants of any of those. Returns
// null for anything else (a direct video file URL, a Vimeo link, ...) -
// exactly the signal training-play.ejs uses to decide which player to
// render (see this file's own header comment). Tolerates a URL pasted
// without a leading scheme (people often paste "youtube.com/watch?v=..."
// straight out of an address bar), but is otherwise a real URL parse, not
// a regex guessing at the whole string - far less brittle against the
// query-param ordering/extra-param variety real YouTube links come in.
function youtubeVideoId(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = String(rawUrl).trim();
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch (err) {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  const isYouTubeId = (id) => /^[A-Za-z0-9_-]{11}$/.test(id || '');

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return isYouTubeId(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return isYouTubeId(id) ? id : null;
    }
    const embedMatch = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    if (embedMatch) return embedMatch[1];
  }
  return null;
}

// ---------------------------------------------------------------------
// Trainings (admin Training Builder)
// ---------------------------------------------------------------------

// Every training, newest first, with a lightweight lesson/assignment
// count for the list page - never the full lesson/question tree (see
// getTrainingWithContent below for that), so this stays cheap even once
// a training has a long lesson list.
async function listTrainings() {
  return db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.training_id = t.id) AS "lessonCount",
        (SELECT COUNT(*) FROM training_assignments ta WHERE ta.training_id = t.id) AS "assignmentCount"
       FROM trainings t
       ORDER BY t.created_at DESC, t.id DESC`
    )
    .all();
}

async function getTraining(id) {
  return db.prepare('SELECT * FROM trainings WHERE id = ?').get(id);
}

// The full editable tree for the Training Builder page - training row,
// every lesson in position order, and (for quiz lessons) every question
// with its options, plus any attached resources. One training's worth of
// content is small enough that building this as a handful of queries
// instead of hand-rolled joins is both simpler and plenty fast.
async function getTrainingWithContent(id) {
  const training = await getTraining(id);
  if (!training) return null;
  const lessons = await db.prepare('SELECT * FROM training_lessons WHERE training_id = ? ORDER BY position, id').all(id);
  for (const lesson of lessons) {
    lesson.resources = await db
      .prepare('SELECT * FROM training_lesson_resources WHERE lesson_id = ? ORDER BY position, id')
      .all(lesson.id);
    if (lesson.type === 'quiz') {
      const questions = await db
        .prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id')
        .all(lesson.id);
      for (const q of questions) {
        q.options = await db
          .prepare('SELECT * FROM training_quiz_options WHERE question_id = ? ORDER BY position, id')
          .all(q.id);
      }
      lesson.questions = questions;
    }
  }
  training.lessons = lessons;
  return training;
}

function clampScore(n, fallback) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

async function createTraining(data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Title is required.');
  const info = await db
    .prepare(
      `INSERT INTO trainings
        (title, description, estimated_minutes, passing_score, sequential_lessons, require_video_completion,
         video_completion_threshold, require_retake_after_failure, allow_skipping_lessons, require_manager_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      (data.description || '').trim() || null,
      parseInt(data.estimatedMinutes, 10) || null,
      clampScore(data.passingScore, 80),
      data.sequentialLessons ? 1 : 0,
      data.requireVideoCompletion ? 1 : 0,
      clampScore(data.videoCompletionThreshold, 95) || 95,
      data.requireRetakeAfterFailure ? 1 : 0,
      data.allowSkippingLessons ? 1 : 0,
      data.requireManagerApproval ? 1 : 0
    );
  return info.lastInsertRowid;
}

async function updateTraining(id, data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Title is required.');
  await db
    .prepare(
      `UPDATE trainings SET
        title = ?, description = ?, estimated_minutes = ?, passing_score = ?,
        sequential_lessons = ?, require_video_completion = ?, video_completion_threshold = ?,
        require_retake_after_failure = ?, allow_skipping_lessons = ?, require_manager_approval = ?,
        updated_at = now_text()
       WHERE id = ?`
    )
    .run(
      title,
      (data.description || '').trim() || null,
      parseInt(data.estimatedMinutes, 10) || null,
      clampScore(data.passingScore, 80),
      data.sequentialLessons ? 1 : 0,
      data.requireVideoCompletion ? 1 : 0,
      clampScore(data.videoCompletionThreshold, 95) || 95,
      data.requireRetakeAfterFailure ? 1 : 0,
      data.allowSkippingLessons ? 1 : 0,
      data.requireManagerApproval ? 1 : 0,
      id
    );
}

// publish/archive/back-to-draft. Publishing with zero lessons is refused
// server-side - a published training with nothing in it can still be
// assigned and would leave a member stuck on an empty outline forever.
async function setTrainingStatus(id, status) {
  if (!TRAINING_STATUSES.includes(status)) throw new Error('Invalid status.');
  if (status === 'published') {
    const row = await db.prepare('SELECT COUNT(*) AS "n" FROM training_lessons WHERE training_id = ?').get(id);
    if (!row || row.n === 0) throw new Error('Add at least one lesson before publishing.');
  }
  await db.prepare('UPDATE trainings SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

// A hard delete is only ever allowed for a draft training nobody has
// been assigned yet - once a real member has a real assignment (even an
// unstarted one), that's a historical record from here on and Archive
// (setTrainingStatus('archived'), which touches nothing else) is the
// only supported way to retire it. Returns false instead of throwing so
// the route can report a clean, expected "can't delete this one" message
// rather than a 500.
async function deleteTraining(id) {
  const training = await getTraining(id);
  if (!training || training.status !== 'draft') return false;
  const row = await db.prepare('SELECT COUNT(*) AS "n" FROM training_assignments WHERE training_id = ?').get(id);
  if (row && row.n > 0) return false;
  await db.prepare('DELETE FROM trainings WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------

async function createLesson(trainingId, data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Lesson title is required.');
  const type = LESSON_TYPES.includes(data.type) ? data.type : 'text';
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM training_lessons WHERE training_id = ?').get(trainingId);
  const position = (row && row.maxPos != null ? row.maxPos : -1) + 1;
  const info = await db
    .prepare(
      `INSERT INTO training_lessons (training_id, title, description, type, position, required, video_url, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      trainingId,
      title,
      (data.description || '').trim() || null,
      type,
      position,
      data.required === undefined || data.required ? 1 : 0,
      (data.videoUrl || '').trim() || null,
      (data.content || '').trim() || null
    );
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(trainingId);
  return info.lastInsertRowid;
}

async function updateLesson(lessonId, data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Lesson title is required.');
  const lesson = await db.prepare('SELECT training_id, type FROM training_lessons WHERE id = ?').get(lessonId);
  if (!lesson) throw new Error('Lesson not found.');
  const type = LESSON_TYPES.includes(data.type) ? data.type : lesson.type;
  await db
    .prepare(
      `UPDATE training_lessons SET title = ?, description = ?, type = ?, required = ?, video_url = ?, content = ?, updated_at = now_text()
       WHERE id = ?`
    )
    .run(
      title,
      (data.description || '').trim() || null,
      type,
      data.required === undefined || data.required ? 1 : 0,
      (data.videoUrl || '').trim() || null,
      (data.content || '').trim() || null,
      lessonId
    );
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(lesson.training_id);
}

async function deleteLesson(lessonId) {
  const lesson = await db.prepare('SELECT training_id FROM training_lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;
  // Historical attempts keep their own snapshot of this lesson (see the
  // migration's own comment on training_lesson_progress) - deleting the
  // live lesson row here never touches past progress/answers, it just
  // removes it from the training going forward.
  await db.prepare('DELETE FROM training_lessons WHERE id = ?').run(lessonId);
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(lesson.training_id);
}

// Drag-free reordering (move up/down) - the same pattern utils/
// taskList.js's own swapSectionPosition/swapItemPosition already use for
// every other admin-ordered list in this app (Setup/Cleanup task
// sections and items). Native drag-and-drop isn't used anywhere else in
// this codebase, so introducing it just for this one screen would be a
// new UI pattern rather than a reused one - these swap buttons keep
// Training Builder consistent with the rest of the admin UI instead.
async function moveLesson(lessonId, direction) {
  const lesson = await db.prepare('SELECT id, training_id, position FROM training_lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;
  const lessons = await db
    .prepare('SELECT id, position FROM training_lessons WHERE training_id = ? ORDER BY position, id')
    .all(lesson.training_id);
  const idx = lessons.findIndex((l) => l.id === lesson.id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= lessons.length) return;
  const a = lessons[idx];
  const b = lessons[swapIdx];
  await db.prepare('UPDATE training_lessons SET position = ? WHERE id = ?').run(b.position, a.id);
  await db.prepare('UPDATE training_lessons SET position = ? WHERE id = ?').run(a.position, b.id);
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(lesson.training_id);
}

// ---------------------------------------------------------------------
// Quiz questions/options
// ---------------------------------------------------------------------

// data.options: [{ text, correct }, ...] - exactly one should be
// correct for a multiple_choice question; the route layer validates that
// before calling this (see routes/admin-training.js), this layer just
// persists whatever it's given.
async function createQuizQuestion(lessonId, data) {
  const question = (data.question || '').trim();
  if (!question) throw new Error('Question text is required.');
  const options = (data.options || []).map((o) => ({ text: (o.text || '').trim(), correct: !!o.correct })).filter((o) => o.text);
  if (options.length < 2) throw new Error('At least two answer options are required.');
  if (!options.some((o) => o.correct)) throw new Error('One option must be marked correct.');

  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM training_quiz_questions WHERE lesson_id = ?').get(lessonId);
  const position = (row && row.maxPos != null ? row.maxPos : -1) + 1;
  const points = Math.max(1, parseInt(data.points, 10) || 1);

  return db.withTransaction(async (tx) => {
    const info = await tx
      .prepare('INSERT INTO training_quiz_questions (lesson_id, question, points, position) VALUES (?, ?, ?, ?)')
      .run(lessonId, question, points, position);
    const questionId = info.lastInsertRowid;
    let i = 0;
    for (const o of options) {
      await tx
        .prepare('INSERT INTO training_quiz_options (question_id, option_text, is_correct, position) VALUES (?, ?, ?, ?)')
        .run(questionId, o.text, o.correct ? 1 : 0, i++);
    }
    return questionId;
  });
}

async function updateQuizQuestion(questionId, data) {
  const question = (data.question || '').trim();
  if (!question) throw new Error('Question text is required.');
  const options = (data.options || []).map((o) => ({ text: (o.text || '').trim(), correct: !!o.correct })).filter((o) => o.text);
  if (options.length < 2) throw new Error('At least two answer options are required.');
  if (!options.some((o) => o.correct)) throw new Error('One option must be marked correct.');
  const points = Math.max(1, parseInt(data.points, 10) || 1);

  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE training_quiz_questions SET question = ?, points = ? WHERE id = ?').run(question, points, questionId);
    // Existing answers already given for this question keep their own
    // snapshot columns (see training_quiz_answers) regardless of this
    // edit, so replacing the option set outright here is safe - it never
    // rewrites history, only what a FUTURE attempt will see.
    await tx.prepare('DELETE FROM training_quiz_options WHERE question_id = ?').run(questionId);
    let i = 0;
    for (const o of options) {
      await tx
        .prepare('INSERT INTO training_quiz_options (question_id, option_text, is_correct, position) VALUES (?, ?, ?, ?)')
        .run(questionId, o.text, o.correct ? 1 : 0, i++);
    }
  });
}

async function deleteQuizQuestion(questionId) {
  await db.prepare('DELETE FROM training_quiz_questions WHERE id = ?').run(questionId);
}

async function moveQuizQuestion(questionId, direction) {
  const question = await db.prepare('SELECT id, lesson_id, position FROM training_quiz_questions WHERE id = ?').get(questionId);
  if (!question) return;
  const questions = await db
    .prepare('SELECT id, position FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id')
    .all(question.lesson_id);
  const idx = questions.findIndex((q) => q.id === question.id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= questions.length) return;
  const a = questions[idx];
  const b = questions[swapIdx];
  await db.prepare('UPDATE training_quiz_questions SET position = ? WHERE id = ?').run(b.position, a.id);
  await db.prepare('UPDATE training_quiz_questions SET position = ? WHERE id = ?').run(a.position, b.id);
}

// ---------------------------------------------------------------------
// Lesson resources (images) - reuses the app's existing image-upload
// pipeline (multer + utils/storage.js), this just records what got
// uploaded and where.
// ---------------------------------------------------------------------

async function addLessonResource(lessonId, filePath, originalName) {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM training_lesson_resources WHERE lesson_id = ?').get(lessonId);
  const position = (row && row.maxPos != null ? row.maxPos : -1) + 1;
  await db
    .prepare('INSERT INTO training_lesson_resources (lesson_id, file_path, original_name, position) VALUES (?, ?, ?, ?)')
    .run(lessonId, filePath, originalName || null, position);
}

async function deleteLessonResource(resourceId) {
  const row = await db.prepare('SELECT file_path FROM training_lesson_resources WHERE id = ?').get(resourceId);
  await db.prepare('DELETE FROM training_lesson_resources WHERE id = ?').run(resourceId);
  return row ? row.file_path : null;
}

// ---------------------------------------------------------------------
// Assignment (admin side)
// ---------------------------------------------------------------------

// Every active member, any type - training isn't inherently scoped to
// parents the way Floater/Setup-Cleanup teams are (module design brief's
// own examples - "New Employee Orientation", "Safety Procedures" - read
// as applying to any adult volunteer, and nothing rules out a student-
// facing training either), so this deliberately doesn't reuse the
// parent-only/parent+admin picker helpers utils/members.js already
// exports for those other features. is_primary_parent/isTeacher ride
// along (not just id/name/member_type) so the Assign page's own picker
// can offer the same Primary Parents/Teachers Only filters the Design/
// Print hub's bulk print pickers already do - a real request: "should
// have a filter option like bulk printing. primary parents, parents,
// students, admins" (teachers added as a follow-up to that same request).
async function activeAssignableMembers() {
  const members = (await db.prepare('SELECT id, name, member_type, is_primary_parent FROM members WHERE active = 1').all()).sort(byLastName);
  const teacherIds = await teacherMemberIds();
  return members.map((m) => ({ ...m, isTeacher: teacherIds.has(m.id) }));
}

// Creates (or leaves alone, if it already exists) a training_assignments
// row for each memberId - ON CONFLICT DO NOTHING so re-assigning someone
// already assigned is a harmless no-op rather than a duplicate-key
// error, and never resets an in-progress/completed assignment back to
// square one just because an admin re-checked their name in the
// assignment dialog. dueAt is optional (a plain 'YYYY-MM-DD' or null).
async function assignTrainingToMembers(trainingId, memberIds, dueAt) {
  const due = dueAt || null;
  let assigned = 0;
  for (const memberId of memberIds) {
    const info = await db
      .prepare(
        `INSERT INTO training_assignments (training_id, member_id, due_at)
         VALUES (?, ?, ?)
         ON CONFLICT (training_id, member_id) DO NOTHING`
      )
      .run(trainingId, memberId, due);
    if (info.changes > 0) assigned++;
  }
  return assigned;
}

async function removeAssignment(assignmentId) {
  await db.prepare('DELETE FROM training_assignments WHERE id = ?').run(assignmentId);
}

// The admin reporting table (module design item 14) - one row per
// assignment for a given training.
async function assignmentsForTraining(trainingId) {
  return (
    await db
      .prepare(
        `SELECT ta.*, m.name AS "memberName", m.member_type AS "memberType"
         FROM training_assignments ta
         JOIN members m ON m.id = ta.member_id
         WHERE ta.training_id = ?`
      )
      .all(trainingId)
  ).sort((a, b) => lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) || a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' }));
}

// The full drill-down behind clicking into one member/training
// assignment (module design item 14's own "useful details" list) - every
// attempt, each with its own lesson progress and quiz answers.
async function assignmentDetail(assignmentId) {
  const assignment = await db
    .prepare(
      `SELECT ta.*, m.name AS "memberName", t.title AS "trainingTitle", t.passing_score AS "trainingPassingScore"
       FROM training_assignments ta
       JOIN members m ON m.id = ta.member_id
       JOIN trainings t ON t.id = ta.training_id
       WHERE ta.id = ?`
    )
    .get(assignmentId);
  if (!assignment) return null;
  const attempts = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC')
    .all(assignmentId);
  for (const attempt of attempts) {
    attempt.lessonProgress = await db
      .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? ORDER BY lesson_position_snapshot, id')
      .all(attempt.id);
    attempt.quizAnswers = await db
      .prepare('SELECT * FROM training_quiz_answers WHERE attempt_id = ? ORDER BY id')
      .all(attempt.id);
  }
  assignment.attempts = attempts;
  return assignment;
}

// ---------------------------------------------------------------------
// Member-facing: Training Player
// ---------------------------------------------------------------------

// Every assignment belonging to memberId, across every training - the
// "My Training" member dashboard (module design item 4).
async function myAssignments(memberId) {
  return db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.estimated_minutes AS "estimatedMinutes", t.status AS "trainingStatus",
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.training_id = t.id) AS "lessonCount"
       FROM training_assignments ta
       JOIN trainings t ON t.id = ta.training_id
       WHERE ta.member_id = ? AND t.status = 'published'
       ORDER BY (ta.status = 'in_progress') DESC, (ta.status = 'retry_required') DESC, ta.assigned_at DESC`
    )
    .all(memberId);
}

// The one server-side ownership check every member-facing route in
// routes/training.js relies on: an assignment id alone (from the URL)
// is never enough - it must also belong to whichever member the
// session itself says is acting right now (see that file's own comment
// on how that identity gets set). Returns null on any mismatch, which
// every caller treats as "not found" - a member probing another
// assignment id gets the exact same response as a nonexistent one, no
// information leak either way.
async function getAssignmentForMember(assignmentId, memberId) {
  return db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.status AS "trainingStatus", t.sequential_lessons AS "sequentialLessons",
        t.allow_skipping_lessons AS "allowSkippingLessons", t.require_video_completion AS "requireVideoCompletion",
        t.video_completion_threshold AS "videoCompletionThreshold", t.passing_score AS "passingScore",
        t.require_retake_after_failure AS "requireRetakeAfterFailure"
       FROM training_assignments ta
       JOIN trainings t ON t.id = ta.training_id
       WHERE ta.id = ? AND ta.member_id = ?`
    )
    .get(assignmentId, memberId);
}

// Snapshots the training's CURRENT lesson list into a fresh set of
// training_lesson_progress rows for a brand new attempt - locked/
// available per the training's own sequential/allow-skipping rules (see
// this file's own header comment on how those two flags interact).
// Never called directly by a route; ensureAttemptStarted/startRetake
// below are the only entry points, so "starting an attempt" always goes
// through the assignment's own status transition too.
async function startAttempt(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  const training = await db.prepare('SELECT * FROM trainings WHERE id = ?').get(assignment.training_id);
  const lessons = await db
    .prepare('SELECT * FROM training_lessons WHERE training_id = ? ORDER BY position, id')
    .all(training.id);
  const attemptNumber = assignment.attempt_count + 1;
  const noLocking = training.allow_skipping_lessons === 1 || training.sequential_lessons !== 1;

  return db.withTransaction(async (tx) => {
    const info = await tx
      .prepare(
        `INSERT INTO training_attempts (assignment_id, attempt_number, passing_score_snapshot, training_title_snapshot)
         VALUES (?, ?, ?, ?)`
      )
      .run(assignmentId, attemptNumber, training.passing_score, training.title);
    const attemptId = info.lastInsertRowid;

    let firstLessonId = null;
    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i];
      const status = noLocking || i === 0 ? 'available' : 'locked';
      if (!firstLessonId) firstLessonId = lesson.id;
      await tx
        .prepare(
          `INSERT INTO training_lesson_progress
            (attempt_id, lesson_id, lesson_title_snapshot, lesson_type_snapshot, lesson_position_snapshot, lesson_required_snapshot, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(attemptId, lesson.id, lesson.title, lesson.type, lesson.position, lesson.required, status);
    }

    await tx
      .prepare(
        `UPDATE training_assignments SET status = 'in_progress', attempt_count = ?, current_lesson_id = ?
         WHERE id = ?`
      )
      .run(attemptNumber, firstLessonId, assignmentId);

    return attemptId;
  });
}

// Idempotent: an assignment with no attempt yet gets its first one
// started; one already in progress just returns the existing current
// attempt untouched. Never auto-starts a new attempt for a finished
// (passed/failed/retry_required) assignment - that's what startRetake
// is for, an explicit member action, not something that happens by
// just opening the player again.
async function ensureAttemptStarted(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  if (!assignment) return null;
  if (assignment.status === 'not_started') {
    await startAttempt(assignmentId);
  }
  return db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
}

// Only allowed once an attempt has actually concluded unsuccessfully -
// mirrors ensureAttemptStarted's own "never silently restart a finished
// assignment" rule, just for the one status this DOES apply to.
async function startRetake(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  if (!assignment || !['failed', 'retry_required'].includes(assignment.status)) {
    throw new Error('This training is not eligible for a retake right now.');
  }
  return startAttempt(assignmentId);
}

// The full Training Player state for one assignment - lesson outline
// with each lesson's own progress row for the CURRENT attempt, overall
// percent-complete (module design item 13's own formula: completed
// required lessons / total required lessons, computed here and nowhere
// else, so there is exactly one place this can ever disagree with
// itself), and the attempt's own latest quiz/grade info once finished.
async function getPlayerState(assignmentId) {
  const assignment = await db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.estimated_minutes AS "estimatedMinutes", t.sequential_lessons AS "sequentialLessons",
        t.allow_skipping_lessons AS "allowSkippingLessons", t.passing_score AS "passingScore",
        t.require_video_completion AS "requireVideoCompletion"
       FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.id = ?`
    )
    .get(assignmentId);
  if (!assignment) return null;
  const attempt = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
  if (!attempt) return { assignment, attempt: null, lessons: [], percentComplete: 0 };

  const lessons = await db
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? ORDER BY lesson_position_snapshot, id')
    .all(attempt.id);
  // completionGatingLessons's own comment explains why a training with
  // zero required lessons falls back to counting every lesson instead of
  // reading as instantly 100% complete.
  const gating = completionGatingLessons(lessons);
  const completedGating = gating.filter((l) => l.status === 'completed');
  const percentComplete = gating.length ? Math.round((completedGating.length / gating.length) * 100) : 100;

  return { assignment, attempt, lessons, percentComplete };
}

// The lessons that must be 'completed' before an attempt can finalize -
// every required lesson, normally. A real bug: `.every()` on an EMPTY
// array is vacuously true, so a training built entirely out of optional
// lessons (every lesson's own "Required to complete this training"
// checkbox left unchecked) had its very first lesson completion
// immediately finalize the whole attempt as passed/failed, with every
// other lesson still sitting untouched - both here (maybeFinalizeAttempt)
// and in getPlayerState's percentComplete, which showed a fresh attempt
// as already 100% before the member had done anything. Falling back to
// every lesson in the attempt when none are marked required keeps
// "finished" meaning what a member/admin would actually expect: every
// lesson in the outline, not an empty required subset.
function completionGatingLessons(lessons) {
  const required = lessons.filter((l) => l.lesson_required_snapshot === 1);
  return required.length ? required : lessons;
}

// Marks one lesson "in progress" (first time it's opened) - refuses a
// lesson this attempt still has locked, the same enforcement completeLesson
// below applies, just for "may I even open this" rather than "may I
// finish this". Returns the lesson's own progress row (or null if it's
// locked/not part of this attempt) so the route can 403 cleanly.
async function startLesson(assignmentId, lessonId) {
  const attempt = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
  if (!attempt) return null;
  const progress = await db
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?')
    .get(attempt.id, lessonId);
  if (!progress || progress.status === 'locked') return null;
  if (progress.status === 'available') {
    await db
      .prepare("UPDATE training_lesson_progress SET status = 'in_progress', started_at = now_text() WHERE id = ?")
      .run(progress.id);
    progress.status = 'in_progress';
    progress.started_at = 'now';
  }
  return progress;
}

// Records real video playback progress - see this file's own header on
// why video_max_watched_seconds tracks the furthest point actually
// reached (via the player's own timeupdate events, routes/training.js's
// job to report honestly) rather than just the latest position, so
// scrubbing straight to the end doesn't count as having watched the
// whole thing. Purely a progress recorder - it never marks the lesson
// itself complete; only completeLesson does that, and only after
// checking video_completed here has already been set to 1.
async function recordVideoProgress(assignmentId, lessonId, currentSeconds, durationSeconds) {
  const attempt = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
  if (!attempt) return null;
  const progress = await db
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?')
    .get(attempt.id, lessonId);
  if (!progress || progress.status === 'locked' || progress.lesson_type_snapshot !== 'video') return null;

  const assignment = await db
    .prepare('SELECT ta.*, t.video_completion_threshold AS "threshold" FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.id = ?')
    .get(assignmentId);

  const current = Math.max(0, Number(currentSeconds) || 0);
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : progress.video_duration_seconds;
  const maxWatched = Math.max(progress.video_max_watched_seconds || 0, current);
  const percent = duration ? Math.min(100, Math.round((maxWatched / duration) * 100)) : 0;
  const nowCompleted = percent >= (assignment.threshold || 95) ? 1 : progress.video_completed;

  await db
    .prepare(
      `UPDATE training_lesson_progress SET
        video_started = 1, video_max_watched_seconds = ?, video_duration_seconds = ?, video_percent = ?,
        video_completed = ?, video_completed_at = CASE WHEN ? = 1 AND video_completed = 0 THEN now_text() ELSE video_completed_at END,
        status = CASE WHEN status = 'available' THEN 'in_progress' ELSE status END
       WHERE id = ?`
    )
    .run(maxWatched, duration || null, percent, nowCompleted, nowCompleted, progress.id);

  return { percent, completed: nowCompleted === 1 };
}

// The core "may this lesson actually be marked done" gate - the backend
// enforcement the module design brief explicitly calls for (item 6/7):
// never trusts anything the client claims, only what this attempt's own
// database rows already say. Handles video/text lessons; a quiz lesson
// completes itself as part of submitQuiz below (grading and completion
// are the same action for a quiz, there's nothing to separately
// "complete").
async function completeLesson(assignmentId, lessonId) {
  const attempt = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
  if (!attempt) throw new Error('No active attempt.');
  const progress = await db
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?')
    .get(attempt.id, lessonId);
  if (!progress) throw new Error('Lesson not found on this attempt.');
  if (progress.status === 'locked') throw new Error('This lesson is locked.');
  if (progress.status === 'completed') return; // idempotent
  if (progress.lesson_type_snapshot === 'quiz') throw new Error('Submit the quiz to complete this lesson.');

  if (progress.lesson_type_snapshot === 'video') {
    const training = await db
      .prepare('SELECT t.require_video_completion AS "requireVideoCompletion" FROM training_attempts ta JOIN training_assignments a ON a.id = ta.assignment_id JOIN trainings t ON t.id = a.training_id WHERE ta.id = ?')
      .get(attempt.id);
    if (training.requireVideoCompletion === 1 && progress.lesson_required_snapshot === 1 && progress.video_completed !== 1) {
      throw new Error('Watch the required video before continuing.');
    }
  }

  await advanceLesson(attempt.id, progress);
  return maybeFinalizeAttempt(attempt.id);
}

// Marks progress.id completed and, when sequential locking applies,
// unlocks the very next lesson in position order (skipping over
// anything already completed, so re-visiting an earlier lesson never
// re-locks what came after it). Shared by completeLesson (called
// standalone, off the plain `db` handle) and submitQuiz (called from
// inside its own db.withTransaction) - `queryable` is whichever of those
// this call is running under. Real bug caught in testing: this used to
// always reach for the outer `db` handle directly, which deadlocked
// PGlite's single connection when called from submitQuiz's still-open
// transaction (the transaction held the one connection submitQuiz's own
// tx.prepare() calls were using, while this function's plain db.prepare()
// calls waited on that same connection to free up - a wait that could
// never end since the transaction itself was waiting on THIS to return).
async function advanceLesson(attemptId, progress, queryable = db) {
  await queryable
    .prepare("UPDATE training_lesson_progress SET status = 'completed', completed_at = now_text() WHERE id = ?")
    .run(progress.id);

  const all = await queryable
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? ORDER BY lesson_position_snapshot, id')
    .all(attemptId);
  const next = all.find((l) => l.status === 'locked');
  if (next) {
    await queryable.prepare("UPDATE training_lesson_progress SET status = 'available' WHERE id = ?").run(next.id);
  }
  const currentLessonId = next ? next.lesson_id : null;
  const assignmentId = (await queryable.prepare('SELECT assignment_id FROM training_attempts WHERE id = ?').get(attemptId)).assignment_id;
  await queryable.prepare('UPDATE training_assignments SET current_lesson_id = ? WHERE id = ?').run(currentLessonId, assignmentId);
}

// Grades a quiz submission and completes the quiz lesson in one step.
// answers is a plain { [questionId]: selectedOptionId } map straight
// from the submitted form - untrusted input in every sense (a member
// could submit any question/option id pair at all). Every question this
// LESSON actually has is re-read fresh from the database and graded
// against its own live is_correct flag; a submitted answer for a
// question that isn't even part of this lesson is simply ignored, and a
// question with no submitted answer at all is recorded as unanswered
// (0 points) rather than silently skipped, so the total questions/points
// possible for this attempt's grade always adds up.
async function submitQuiz(assignmentId, lessonId, answers) {
  const attempt = await db
    .prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1')
    .get(assignmentId);
  if (!attempt) throw new Error('No active attempt.');
  const progress = await db
    .prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?')
    .get(attempt.id, lessonId);
  if (!progress) throw new Error('Lesson not found on this attempt.');
  if (progress.status === 'locked') throw new Error('This lesson is locked.');
  if (progress.lesson_type_snapshot !== 'quiz') throw new Error('This lesson is not a quiz.');
  if (progress.status === 'completed') throw new Error('This quiz has already been submitted.');

  const questions = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lessonId);

  await db.withTransaction(async (tx) => {
    for (const q of questions) {
      const submittedOptionId = answers && Object.prototype.hasOwnProperty.call(answers, String(q.id)) ? parseInt(answers[String(q.id)], 10) : null;
      let selectedOption = null;
      if (submittedOptionId) {
        selectedOption = await tx
          .prepare('SELECT * FROM training_quiz_options WHERE id = ? AND question_id = ?')
          .get(submittedOptionId, q.id);
      }
      const isCorrect = !!(selectedOption && selectedOption.is_correct === 1);
      const pointsEarned = isCorrect ? q.points : 0;
      await tx
        .prepare(
          `INSERT INTO training_quiz_answers
            (attempt_id, question_id, question_text_snapshot, points_possible_snapshot, selected_option_id,
             selected_option_text_snapshot, is_correct, points_earned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (attempt_id, question_id) DO UPDATE SET
             selected_option_id = excluded.selected_option_id,
             selected_option_text_snapshot = excluded.selected_option_text_snapshot,
             is_correct = excluded.is_correct,
             points_earned = excluded.points_earned`
        )
        .run(
          attempt.id,
          q.id,
          q.question,
          q.points,
          selectedOption ? selectedOption.id : null,
          selectedOption ? selectedOption.option_text : null,
          isCorrect ? 1 : 0,
          pointsEarned
        );
    }
    await advanceLesson(attempt.id, progress, tx);
  });

  return maybeFinalizeAttempt(attempt.id);
}

// Once every required lesson in this attempt is completed, computes the
// final score from every quiz answer this attempt has recorded (across
// every quiz lesson in the training - module design item 9/10: multiple
// quizzes, one combined score), decides pass/fail against the
// PASSING-SCORE SNAPSHOT this attempt itself was started under (never
// the training's current, possibly-since-edited value - module design
// item 19), and updates both the attempt and the assignment. A training
// with no quiz questions at all grades as a trivial 100% - there's
// nothing to fail, "complete all lessons" already fully covers what
// finishing it means.
async function maybeFinalizeAttempt(attemptId) {
  const lessons = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ?').all(attemptId);
  const requiredDone = completionGatingLessons(lessons).every((l) => l.status === 'completed');
  if (!requiredDone) return { finalized: false };

  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE id = ?').get(attemptId);
  if (attempt.completed_at) return { finalized: true, alreadyDone: true, score: attempt.score, passed: attempt.passed === 1 };

  const answers = await db.prepare('SELECT * FROM training_quiz_answers WHERE attempt_id = ?').all(attemptId);
  const possible = answers.reduce((sum, a) => sum + a.points_possible_snapshot, 0);
  const earned = answers.reduce((sum, a) => sum + a.points_earned, 0);
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 100;
  const passed = score >= attempt.passing_score_snapshot;

  const assignment = await db
    .prepare('SELECT ta.*, t.require_retake_after_failure AS "requireRetake" FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.id = ?')
    .get(attempt.assignment_id);

  await db.withTransaction(async (tx) => {
    await tx.prepare("UPDATE training_attempts SET completed_at = now_text(), score = ?, passed = ? WHERE id = ?").run(score, passed ? 1 : 0, attemptId);
    const bestScore = assignment.best_score == null ? score : Math.max(assignment.best_score, score);
    const status = passed ? 'passed' : assignment.requireRetake === 1 ? 'retry_required' : 'failed';
    await tx
      .prepare(
        `UPDATE training_assignments SET status = ?, latest_score = ?, best_score = ?, completed_at = CASE WHEN ? = 1 THEN now_text() ELSE completed_at END
         WHERE id = ?`
      )
      .run(status, score, bestScore, passed ? 1 : 0, assignment.id);
  });

  return { finalized: true, score, passed };
}

module.exports = {
  LESSON_TYPES,
  TRAINING_STATUSES,
  ASSIGNMENT_STATUSES,
  youtubeVideoId,
  listTrainings,
  getTraining,
  getTrainingWithContent,
  createTraining,
  updateTraining,
  setTrainingStatus,
  deleteTraining,
  createLesson,
  updateLesson,
  deleteLesson,
  moveLesson,
  createQuizQuestion,
  updateQuizQuestion,
  deleteQuizQuestion,
  moveQuizQuestion,
  addLessonResource,
  deleteLessonResource,
  activeAssignableMembers,
  assignTrainingToMembers,
  removeAssignment,
  assignmentsForTraining,
  assignmentDetail,
  myAssignments,
  getAssignmentForMember,
  ensureAttemptStarted,
  startRetake,
  getPlayerState,
  startLesson,
  recordVideoProgress,
  completeLesson,
  submitQuiz,
};
