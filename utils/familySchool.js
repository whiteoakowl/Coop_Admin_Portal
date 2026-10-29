// Family School Management - a real request: "Parent portal, student
// portal and main admin portal add a tab called family school
// management. Under this tab parent can create classed, lessons and
// assignments and assign these classes to their own students in their
// family. These classes will then appear under the students portal to
// work ok and complete. Parents can edit, track and view all of it.
// Subpage for grades, subapge for parent to take attendance by the
// date... Subpage for teacher journal... These classes are completely
// seperate from co-op classes and schedules as well as co-op teachers.
// It has nothing to do with that at all." See the family_school_
// management migration's own header comment for the full schema
// rationale - this mirrors the SHAPE of utils/academics.js's own class/
// lesson/content-item/submission system, never its actual tables.
//
// Deliberately simpler than academics.js in two ways: no quiz content
// type (never asked for here), and no open/close-date lesson locking or
// "must complete lessons in order" sequencing (academics.js's own
// isLessonLockedForStudent) - nothing in the request calls for either,
// and a homeschooling parent is also the one assigning the work, not a
// separate teacher who'd need that kind of enforced pacing.
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { formatDateLabel, formatDateLong } = require('./dates');
const { byLastName } = require('./members');
const { createStorageClient, uploadFile, deleteFile, downloadFile, generateKey } = require('./storage');
const { urlForUpload } = require('./uploadBackend');
// A real request: "Lesson plans... Be able to make lesson plans
// available for parents to use to assign to students under family
// school management, family classes." contentItemsForLessonPlan is the
// same read helper routes/admin-lesson-plans.js's own admin view uses -
// a Family Classes lesson that references a plan (source_lesson_plan_id,
// see createLesson/contentItemsForLesson below) reads its content live
// from there, never a copy (this file never needs the plan row itself,
// or its locked flag - see contentItemsForReferencedLessonPlan's own
// comment below on why).
const { contentItemsForLessonPlan, listFamilySchoolLessonPlans, getLessonPlan } = require('./lessonPlans');

// Same bucket/local-dir convention routes/admin-members.js/routes/member-
// directory.js already established for member photos - read-only reuse
// here (resolving a URL for an already-stored members.photo_path), not a
// second upload path of its own.
const MEMBER_PHOTOS_BUCKET = 'member-photos';
const memberPhotosStorageClient = createStorageClient();
function memberPhotoUrl(photoPath) {
  return urlForUpload({ client: memberPhotosStorageClient, bucket: MEMBER_PHOTOS_BUCKET, webDir: '/uploads/members', key: photoPath });
}

const CONTENT_ITEM_TYPES = ['video', 'text', 'file', 'assignment_upload', 'assignment_submission'];

const ATTACHMENTS_BUCKET = 'family-school-attachments';
const ATTACHMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'family-school-attachments');
if (!createStorageClient() && !fs.existsSync(ATTACHMENT_DIR)) {
  try {
    fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${ATTACHMENT_DIR}:`, err.message);
  }
}

// A real decision: this bucket is private (personal, family-owned
// content - logos, lesson attachments, journal attachments, weekly
// planner files - no reason any of it needs a stable public URL). A
// private bucket has no publicUrl() of its own to hand back, so this
// instead points at this app's own proxy-download route (GET below),
// same "download the bytes server-side and stream them through the
// app" pattern routes/admin-documents.js already uses for its own
// private `documents` bucket. Every call site already just drops this
// string straight into an <a href>/<img src> unchanged, so swapping
// what it points to needed no view changes.
function attachmentUrl(key) {
  if (!key) return null;
  return `/family-school/files/${encodeURIComponent(key)}`;
}

async function saveAttachment(file, existingKey) {
  const client = createStorageClient();
  let key;
  if (client) {
    key = await uploadFile(client, ATTACHMENTS_BUCKET, file.buffer, file.originalname, file.mimetype);
  } else {
    key = generateKey(file.originalname);
    fs.writeFileSync(path.join(ATTACHMENT_DIR, key), file.buffer);
  }
  if (existingKey) {
    if (client) await deleteFile(client, ATTACHMENTS_BUCKET, existingKey);
    else {
      const oldPath = path.join(ATTACHMENT_DIR, existingKey);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  return key;
}

// The raw bytes behind a saveAttachment() key - the other half of the
// private-bucket proxy-download route (attachmentUrl() above builds the
// link to it; attachmentAccessForFamily() below is the authorization
// check that must pass before this is ever called).
async function attachmentBuffer(key) {
  if (!key) return null;
  const client = createStorageClient();
  if (client) return downloadFile(client, ATTACHMENTS_BUCKET, key);
  const filePath = path.join(ATTACHMENT_DIR, key);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

// Confirms `familyId` actually owns the attachment at `key` before the
// proxy-download route streams anything back - checked against every
// table that can hold a family-school-attachments key (a logo, a lesson
// content attachment, a student's assignment submission, a journal
// attachment, or a weekly planner assignment's file), each joined back
// to the owning family. Returns the stored mimetype (possibly null - a
// handful of these columns are new backfills with nothing to fill in
// for already-existing rows) on a real match, or null for "not found"
// and "not yours" alike - the route never distinguishes the two, so a
// wrong guess at someone else's key can't even confirm the key exists.
async function attachmentAccessForFamily(familyId, key) {
  if (!familyId || !key) return null;

  const settingsRow = await db.prepare('SELECT logo_mime FROM family_school_settings WHERE family_id = ? AND logo_key = ?').get(familyId, key);
  if (settingsRow) return { mimeType: settingsRow.logo_mime };

  const contentItemRow = await db
    .prepare(
      `SELECT ci.attachment_mime FROM family_school_content_items ci
       JOIN family_school_lessons l ON l.id = ci.lesson_id
       JOIN family_school_classes c ON c.id = l.class_id
       WHERE c.family_id = ? AND ci.attachment_url = ?`
    )
    .get(familyId, key);
  if (contentItemRow) return { mimeType: contentItemRow.attachment_mime };

  const submissionRow = await db
    .prepare(
      `SELECT s.file_mime FROM family_school_assignment_submissions s
       JOIN members m ON m.id = s.student_id
       WHERE m.family_id = ? AND s.file_url = ?`
    )
    .get(familyId, key);
  if (submissionRow) return { mimeType: submissionRow.file_mime };

  const journalRow = await db
    .prepare(
      `SELECT a.content_type FROM family_school_journal_attachments a
       JOIN family_school_journal_entries e ON e.id = a.journal_entry_id
       JOIN members m ON m.id = e.student_id
       WHERE m.family_id = ? AND a.file_key = ?`
    )
    .get(familyId, key);
  if (journalRow) return { mimeType: journalRow.content_type };

  const weekAssignmentRow = await db
    .prepare(
      `SELECT wa.file_mime FROM family_school_week_assignments wa
       JOIN family_school_week_dates wd ON wd.id = wa.week_date_id
       JOIN family_school_weeks w ON w.id = wd.week_id
       WHERE w.family_id = ? AND wa.file_key = ?`
    )
    .get(familyId, key);
  if (weekAssignmentRow) return { mimeType: weekAssignmentRow.file_mime };

  return null;
}

// --- Classes ---

async function classesForFamily(familyId) {
  const classes = await db
    .prepare('SELECT * FROM family_school_classes WHERE family_id = ? ORDER BY class_name COLLATE "C"')
    .all(familyId);
  return Promise.all(
    classes.map(async (c) => {
      const students = await studentsForClass(c.id);
      const lessonCount = (await db.prepare('SELECT COUNT(*) AS n FROM family_school_lessons WHERE class_id = ?').get(c.id)).n;
      return { ...c, students, lessonCount: Number(lessonCount) };
    })
  );
}

async function getClass(id) {
  return db.prepare('SELECT * FROM family_school_classes WHERE id = ?').get(id);
}

async function createClass({ familyId, className, description, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO family_school_classes (family_id, class_name, description, created_by_account_id) VALUES (?, ?, ?, ?)')
    .run(familyId, className, description || null, createdByAccountId);
  return info.lastInsertRowid;
}

// A real request: "+preplanned class" button, later changed to pull
// from the admin's own Lesson Plans library instead of a fixed built-in
// set: "Lessons should show up under add preplanned class button." Only
// plans an admin flagged allow_family_school_use (utils/lessonPlans.js's
// own listFamilySchoolLessonPlans) are offered - picking one creates a
// new class named after the plan, with one lesson already added that
// references the plan (same live read-through "Choose from Lesson Plans
// library" source createLesson's own sourceLessonPlanId already gives
// the "+ New Lesson" dialog), so it stays in sync with the admin's
// original and can never be edited out from under them if locked.
async function createClassFromLessonPlan(lessonPlanId, familyId, createdByAccountId) {
  const plan = await getLessonPlan(lessonPlanId);
  if (!plan || !plan.allow_family_school_use) return null;
  const classId = await createClass({ familyId, className: plan.title, description: plan.description, createdByAccountId });
  await createLesson({ classId, title: plan.title, description: plan.description, createdByAccountId, sourceLessonPlanId: plan.id });
  return classId;
}

async function updateClass(id, { className, description }) {
  await db
    .prepare("UPDATE family_school_classes SET class_name = ?, description = ?, updated_at = now_text() WHERE id = ?")
    .run(className, description || null, id);
}

async function deleteClass(id) {
  await db.prepare('DELETE FROM family_school_classes WHERE id = ?').run(id);
}

async function studentsForClass(classId) {
  return (
    await db
      .prepare(
        `SELECT m.* FROM family_school_class_students fcs
         JOIN members m ON m.id = fcs.student_id
         WHERE fcs.class_id = ?`
      )
      .all(classId)
  ).sort(byLastName);
}

// Full replace, not individual add/remove - the Class Details form posts
// its whole checkbox set of the family's own students at once, same
// "whichever ones are checked right now win" shape the co-op's own
// class-staff-picker forms already use elsewhere in this app.
async function assignClassToStudents(classId, studentIds) {
  await db.prepare('DELETE FROM family_school_class_students WHERE class_id = ?').run(classId);
  for (const studentId of studentIds) {
    await db
      .prepare('INSERT INTO family_school_class_students (class_id, student_id) VALUES (?, ?) ON CONFLICT (class_id, student_id) DO NOTHING')
      .run(classId, studentId);
  }
}

// Every class assigned to this one student, across however many their
// family has - what Student Portal's own Family School tab lists.
async function classesForStudent(studentId) {
  return db
    .prepare(
      `SELECT c.* FROM family_school_classes c
       JOIN family_school_class_students fcs ON fcs.class_id = c.id
       WHERE fcs.student_id = ?
       ORDER BY c.class_name COLLATE "C"`
    )
    .all(studentId);
}

// --- Lessons ---

async function lessonsForClass(classId) {
  return db.prepare('SELECT * FROM family_school_lessons WHERE class_id = ? ORDER BY position, id').all(classId);
}

async function getLesson(id) {
  return db.prepare('SELECT * FROM family_school_lessons WHERE id = ?').get(id);
}

// sourceLessonPlanId - "Choose from Lesson Plans library" (routes/
// parent-family-school.js's own POST .../lessons), set alongside the
// ordinary "write my own" path below it. Once set, this lesson's own
// content items are never read (see contentItemsForLesson below) - the
// plan's content shows through live instead.
async function createLesson({ classId, title, description, createdByAccountId, sourceLessonPlanId }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_lessons WHERE class_id = ?')
    .get(classId);
  const info = await db
    .prepare('INSERT INTO family_school_lessons (class_id, title, description, position, created_by_account_id, source_lesson_plan_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(classId, title, description || null, nextPosition, createdByAccountId, sourceLessonPlanId || null);
  return info.lastInsertRowid;
}

async function updateLesson(id, { title, description }) {
  await db
    .prepare("UPDATE family_school_lessons SET title = ?, description = ?, updated_at = now_text() WHERE id = ?")
    .run(title, description || null, id);
}

async function deleteLesson(id) {
  await db.prepare('DELETE FROM family_school_lessons WHERE id = ?').run(id);
}

// "They can still, say, remove the reference or unassign it from their
// own class" - drops the link back to the library (the lesson itself,
// and its class/students/position, all stay put) so the parent can then
// add their own content instead, or pick a different plan. Never touches
// lesson_plans itself.
async function unlinkLessonFromPlan(id) {
  await db.prepare('UPDATE family_school_lessons SET source_lesson_plan_id = NULL, updated_at = now_text() WHERE id = ?').run(id);
}

async function reorderLessons(classId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE family_school_lessons SET position = ? WHERE id = ? AND class_id = ?').run(i, orderedIds[i], classId);
  }
}

// --- Content items (the lesson/assignment material itself) ---

async function getContentItem(id) {
  return db.prepare('SELECT * FROM family_school_content_items WHERE id = ?').get(id);
}

// A referenced lesson (source_lesson_plan_id set) always reads its
// content live from the library plan instead of its own (empty)
// family_school_content_items rows - see createLesson's own comment.
// Every existing caller (the parent's own manage page, and - via
// lessonsForStudentView below - the student's read-only view) gets this
// for free with no call-site changes of its own.
async function contentItemsForLesson(lessonId) {
  const lesson = await db.prepare('SELECT source_lesson_plan_id FROM family_school_lessons WHERE id = ?').get(lessonId);
  if (lesson && lesson.source_lesson_plan_id) {
    return contentItemsForReferencedLessonPlan(lesson.source_lesson_plan_id);
  }
  const items = await db.prepare('SELECT * FROM family_school_content_items WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
  return items.map((item) => ({ ...item, attachmentUrl: attachmentUrl(item.attachment_url) }));
}

// lesson_plan_content_items has no due_date/attachment_mime of its own
// (see the lesson_plans migration's own comment on why - due dates only
// ever make sense once something is attached to real students, and these
// never get copied at all) - due_date is nulled out explicitly here so
// callers that check it (dueDateLabel below, the manage table) just see
// "no due date" instead of an undefined field. fromLessonPlan marks every
// item as not-this-lesson's-own, which is what actually keeps it read-
// only everywhere a Family Classes lesson is shown (no edit/delete
// controls in the manage partial, never a clickable/completable bar in
// lessons-view.ejs) - never conditioned on the plan's own locked flag,
// since there is no path for a parent to write to lesson_plan_content_
// items at all, locked or not (see utils/lessonPlans.js's own
// isLessonPlanLocked comment).
async function contentItemsForReferencedLessonPlan(lessonPlanId) {
  const items = await contentItemsForLessonPlan(lessonPlanId, { includeAnswerKey: false });
  return items.map((item) => ({ ...item, due_date: null, fromLessonPlan: true }));
}

async function createContentItem({ lessonId, type, title, videoUrl, body, fileUrl, description, attachmentUrl: attachmentKey, attachmentName, attachmentMime, pointsPossible, dueDate }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_content_items WHERE lesson_id = ?')
    .get(lessonId);
  const info = await db
    .prepare(
      `INSERT INTO family_school_content_items (lesson_id, type, position, title, video_url, body, file_url, description, attachment_url, attachment_name, attachment_mime, points_possible, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lessonId, type, nextPosition, title || null, videoUrl || null, body || null, fileUrl || null,
      description || null, attachmentKey || null, attachmentName || null, attachmentMime || null, pointsPossible != null ? pointsPossible : null, dueDate || null
    );
  return info.lastInsertRowid;
}

async function updateContentItem(id, { title, videoUrl, body, fileUrl, description, attachmentUrl: attachmentKey, attachmentName, attachmentMime, pointsPossible, dueDate }) {
  await db
    .prepare(
      `UPDATE family_school_content_items SET title = ?, video_url = ?, body = ?, file_url = ?, description = ?, attachment_url = ?, attachment_name = ?, attachment_mime = ?, points_possible = ?, due_date = ? WHERE id = ?`
    )
    .run(
      title || null, videoUrl || null, body || null, fileUrl || null, description || null,
      attachmentKey || null, attachmentName || null, attachmentMime || null, pointsPossible != null ? pointsPossible : null, dueDate || null, id
    );
}

async function deleteContentItem(id) {
  await db.prepare('DELETE FROM family_school_content_items WHERE id = ?').run(id);
}

async function reorderContentItems(lessonId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE family_school_content_items SET position = ? WHERE id = ? AND lesson_id = ?').run(i, orderedIds[i], lessonId);
  }
}

// --- Completion (video/text/file/assignment_upload - the plain "Mark
// Complete" click, same shape as academics.js's own lesson_item_completions) ---

async function getLessonItemCompletion(contentItemId, studentId) {
  return db.prepare('SELECT * FROM family_school_lesson_item_completions WHERE content_item_id = ? AND student_id = ?').get(contentItemId, studentId);
}

async function markLessonItemComplete(contentItemId, studentId) {
  await db
    .prepare(
      `INSERT INTO family_school_lesson_item_completions (content_item_id, student_id) VALUES (?, ?)
       ON CONFLICT (content_item_id, student_id) DO NOTHING`
    )
    .run(contentItemId, studentId);
}

// --- Assignment submission (assignment_submission content items - the
// student's own work handed back in, gradable by the parent) ---

async function getAssignmentSubmission(contentItemId, studentId) {
  return db.prepare('SELECT * FROM family_school_assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(contentItemId, studentId);
}

async function submitAssignment({ contentItemId, studentId, fileUrl, fileName, fileMime }) {
  await db
    .prepare(
      `INSERT INTO family_school_assignment_submissions (content_item_id, student_id, file_url, file_name, file_mime, submitted_at, status, points_earned, grade_letter, feedback, graded_at)
       VALUES (?, ?, ?, ?, ?, now_text(), 'submitted', NULL, NULL, NULL, NULL)
       ON CONFLICT (content_item_id, student_id) DO UPDATE SET
         file_url = excluded.file_url, file_name = excluded.file_name, file_mime = excluded.file_mime, submitted_at = now_text(),
         status = 'submitted', points_earned = NULL, grade_letter = NULL, feedback = NULL, graded_at = NULL`
    )
    .run(contentItemId, studentId, fileUrl, fileName, fileMime || null);
}

async function gradeAssignmentSubmission({ contentItemId, studentId, pointsEarned, gradeLetter, feedback }) {
  await db
    .prepare(
      `UPDATE family_school_assignment_submissions SET status = 'graded', points_earned = ?, grade_letter = ?, feedback = ?, graded_at = now_text()
       WHERE content_item_id = ? AND student_id = ?`
    )
    .run(pointsEarned != null && pointsEarned !== '' ? pointsEarned : null, gradeLetter || null, feedback || null, contentItemId, studentId);
}

// --- Student view (Student Portal's own "work on and complete" list) ---

// No open/close-date gating or "complete in order" lock - see this
// file's own header comment on why that academics.js behavior wasn't
// carried over. Every lesson's content always shows; completedCount/
// totalCount still gives the same "1/5 done" progress bar the co-op
// Lessons tab already shows, since that's cheap and genuinely useful
// regardless of locking.
async function lessonsForStudentView(classId, studentId) {
  const lessons = await lessonsForClass(classId);
  return Promise.all(
    lessons.map(async (lesson) => {
      const contentItems = await contentItemsForLesson(lesson.id);
      const withCompletion = await Promise.all(
        contentItems.map(async (item) => {
          const dueDateLabel = item.due_date ? formatDateLabel(item.due_date) : null;
          // fromLessonPlan items (contentItemsForLesson, above) carry a
          // lesson_plan_content_items id, never a real family_school_
          // content_items one - never look that id up in either
          // completion table below, since a coincidentally-matching id
          // there would belong to a totally different piece of content.
          if (item.fromLessonPlan) return { ...item, dueDateLabel, submission: null, completed: false };
          if (item.type === 'assignment_submission') {
            const submission = await getAssignmentSubmission(item.id, studentId);
            return { ...item, dueDateLabel, submission: submission || null, completed: !!submission };
          }
          const completion = await getLessonItemCompletion(item.id, studentId);
          return { ...item, dueDateLabel, completed: !!completion };
        })
      );
      const completedCount = withCompletion.filter((item) => item.completed).length;
      // isOpen/isPastClose/locked: always true/false/false - this file's
      // own header comment on why there's no open/close-date gating or
      // "complete lessons in order" locking here. Set anyway (not just
      // omitted) so the shared partials/lessons-view.ejs partial (built
      // for academics.js's own richer lessonsForStudentView) renders this
      // exact same "always unlocked, always open" shape without any
      // template changes of its own.
      return { ...lesson, isOpen: true, isPastClose: false, locked: false, contentItems: withCompletion, completedCount, totalCount: withCompletion.length };
    })
  );
}

// "Parent/student clicks on an assignment... there should be a next
// button to go to the next assignment" - same linear-scan shape
// academics.js's own nextContentItemAfter uses.
function nextContentItemAfter(lessons, currentItemId) {
  const flat = [];
  for (const lesson of lessons) {
    for (const item of lesson.contentItems) flat.push(item);
  }
  const index = flat.findIndex((item) => item.id === currentItemId);
  if (index === -1) return null;
  // fromLessonPlan items are never linkable (routes/student-family-
  // school.js's own detail route has nothing real to show for one - see
  // contentItemsForLesson's own comment) - skip past any of those to the
  // next real item, same as if they weren't in the list at all.
  for (let i = index + 1; i < flat.length; i++) {
    if (!flat[i].fromLessonPlan) return flat[i];
  }
  return null;
}

// --- Grades (the Grades subpage - a real request: "Subpage for grades."
// No separate grades table - every assignment_submission content item
// already carries its own points_earned/grade_letter/feedback once
// graded, so this just aggregates that across every class/lesson
// assigned to the student, same "read live from the content items
// themselves" shape the co-op's own gradebookForAssignment reads from
// assignment_grades.) ---

async function gradesForStudent(studentId) {
  const rows = await db
    .prepare(
      `SELECT
         c.id AS class_id, c.class_name,
         l.id AS lesson_id, l.title AS lesson_title,
         ci.id AS content_item_id, ci.title AS item_title, ci.points_possible, ci.due_date,
         s.id AS submission_id, s.status, s.points_earned, s.grade_letter, s.feedback, s.submitted_at, s.graded_at
       FROM family_school_class_students fcs
       JOIN family_school_classes c ON c.id = fcs.class_id
       JOIN family_school_lessons l ON l.class_id = c.id
       JOIN family_school_content_items ci ON ci.lesson_id = l.id AND ci.type = 'assignment_submission'
       LEFT JOIN family_school_assignment_submissions s ON s.content_item_id = ci.id AND s.student_id = fcs.student_id
       WHERE fcs.student_id = ?
       ORDER BY c.class_name COLLATE "C", l.position, ci.position`
    )
    .all(studentId);
  return rows.map((r) => ({
    ...r,
    dueDateLabel: r.due_date ? formatDateLabel(r.due_date) : null,
  }));
}

// A standard 90/80/70/60 cutoff and 4.0 letter-to-GPA-point scale - the
// same convention most US schools (and this app's own grade_letter free-
// text field elsewhere) already assume, used here only to turn a class's
// own raw points_earned/points_possible into something summarizable
// (a letter per class, a GPA across classes) for the Overview page below.
function percentToLetterGrade(percent) {
  if (percent == null) return null;
  if (percent >= 90) return 'A';
  if (percent >= 80) return 'B';
  if (percent >= 70) return 'C';
  if (percent >= 60) return 'D';
  return 'F';
}
const LETTER_GRADE_GPA_POINTS = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// The Parent Portal's own Family School Management landing page (a real
// request: "This page shows a card per kid. Each card shows the
// students name, grade level, list of family classes and their overall
// grade next to each class. Also over gpa based on current individual
// class grades... Each card also has the students profile picture from
// their profile. Each card also has a total count of attendance days
// from family management attendance per student. 1/180.") - one row per
// student in the family, each with:
//   - every class assigned to them, with an aggregate grade (summed
//     points_earned/points_possible across every graded
//     assignment_submission content item in that class - no separate
//     grades table, same "read live off the content items" approach
//     gradesForStudent above already takes) turned into a letter grade;
//     a class with nothing graded yet shows no grade rather than an F.
//   - an overall GPA: the plain average of each GRADED class's own GPA
//     points (a class with no grade yet doesn't drag the average down -
//     "nothing graded" isn't the same as "failing").
//   - a running count of 'present' attendance days against
//     ATTENDANCE_TARGET_DAYS (180 - the number of instructional days
//     most US states require of a homeschooler's year), e.g. "1/180".
const ATTENDANCE_TARGET_DAYS = 180;

// The per-student grades/GPA/attendance stat bundle the Overview cards
// show - its own function (rather than inlined in overviewForFamily's
// own map callback) so the new Portfolio subpage (a real request: "add
// a subpage called portfolio... summarize all family school management
// features for each student") can build the exact same numbers for ONE
// student without re-deriving this logic a second, possibly-drifting
// way. A later real request ("Filter buttons should have student
// dropdown choice and school year choice") added the optional
// schoolYear ("YYYY-YYYY") - when given, GPA only counts assignments
// due in that Aug-Jul span and presentDays only counts attendance
// marked in it, same boundary attendanceForSchoolYear above already
// uses; omitted (the Overview page's own long-standing default), both
// stay all-time, same as before this filter existed.
async function statsForStudent(student, schoolYear) {
  const range = schoolYear ? (([startYear]) => [`${startYear}-08-01`, `${Number(startYear) + 1}-07-31`])(schoolYear.split('-')) : null;
  const classes = await classesForStudent(student.id);
  const classesWithGrades = await Promise.all(
    classes.map(async (cls) => {
      const totals = await db
        .prepare(
          `SELECT COALESCE(SUM(s.points_earned), 0) AS earned, COALESCE(SUM(ci.points_possible), 0) AS possible
           FROM family_school_lessons l
           JOIN family_school_content_items ci ON ci.lesson_id = l.id AND ci.type = 'assignment_submission'
           JOIN family_school_assignment_submissions s ON s.content_item_id = ci.id AND s.student_id = ? AND s.status = 'graded'
           WHERE l.class_id = ?${range ? ' AND ci.due_date BETWEEN ? AND ?' : ''}`
        )
        .get(...(range ? [student.id, cls.id, range[0], range[1]] : [student.id, cls.id]));
      const possible = Number(totals.possible);
      const percent = possible > 0 ? (Number(totals.earned) / possible) * 100 : null;
      return { ...cls, gradePercent: percent, gradeLetter: percentToLetterGrade(percent) };
    })
  );
  const gradedClasses = classesWithGrades.filter((c) => c.gradeLetter);
  const gpa =
    gradedClasses.length > 0
      ? gradedClasses.reduce((sum, c) => sum + LETTER_GRADE_GPA_POINTS[c.gradeLetter], 0) / gradedClasses.length
      : null;
  const presentDays = Number(
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM family_school_attendance WHERE student_id = ? AND status = 'present'${range ? ' AND attendance_date BETWEEN ? AND ?' : ''}`)
        .get(...(range ? [student.id, range[0], range[1]] : [student.id]))
    ).n
  );
  return {
    ...student,
    photoUrl: memberPhotoUrl(student.photo_path),
    classes: classesWithGrades,
    gpa,
    presentDays,
    attendanceTargetDays: ATTENDANCE_TARGET_DAYS,
  };
}

async function overviewForFamily(familyId, schoolYear) {
  const students = await db
    .prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'student' AND active = 1 ORDER BY name COLLATE \"C\"")
    .all(familyId);
  return Promise.all(students.map((s) => statsForStudent(s, schoolYear)));
}

// --- Attendance (the Attendance subpage - a real request: "View a
// calendar and mark days student is present for school by clicking on
// the date and it highlights gren. If you click again it becomes red
// for didn't do school.") ---

async function attendanceForStudent(studentId, year, month) {
  // month is 1-indexed (January = 1), matching how the calendar view
  // itself is navigated (a plain ?month=YYYY-MM query param).
  const monthStr = String(month).padStart(2, '0');
  const prefix = `${year}-${monthStr}`;
  const rows = await db
    .prepare("SELECT attendance_date, status FROM family_school_attendance WHERE student_id = ? AND attendance_date LIKE ?")
    .all(studentId, `${prefix}-%`);
  const byDate = {};
  for (const r of rows) byDate[r.attendance_date] = r.status;
  return byDate;
}

// Every attendance row ever marked for this student, oldest first - the
// Export/Download CSV buttons' own data (unlike attendanceForStudent
// above, which is deliberately scoped to one calendar month for the
// Attendance page's own grid).
async function allAttendanceForStudent(studentId) {
  return db.prepare('SELECT attendance_date, status FROM family_school_attendance WHERE student_id = ? ORDER BY attendance_date').all(studentId);
}

// A real request: "Pdf and print should show all 12 months, August-
// July 2026-2027." One calendar grid per month, August of
// schoolYearStartYear through July of schoolYearStartYear+1 - the same
// Aug-Jul school-year convention currentSchoolYear()/schoolYearOptions()
// already use for Annual Planner. A single query for the whole 12-month
// span (rather than 12 separate attendanceForStudent calls) since every
// date in it is unique, so one shared byDate dict serves every month's
// own grid lookup without ever mixing two months' data together.
async function attendanceForSchoolYear(studentId, schoolYearStartYear) {
  const rows = await db
    .prepare('SELECT attendance_date, status FROM family_school_attendance WHERE student_id = ? AND attendance_date >= ? AND attendance_date <= ?')
    .all(studentId, `${schoolYearStartYear}-08-01`, `${schoolYearStartYear + 1}-07-31`);
  const byDate = {};
  for (const r of rows) byDate[r.attendance_date] = r.status;
  const SCHOOL_YEAR_MONTHS = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
  return SCHOOL_YEAR_MONTHS.map((month, i) => {
    const year = i < 5 ? schoolYearStartYear : schoolYearStartYear + 1;
    return { year, month, weeks: monthGridDays(year, month), attendanceByDate: byDate };
  });
}

// A plain weeks-of-the-month grid for the Attendance calendar - Sunday-
// start, padded with null on either end so every week is a real 7-cell
// row. Nothing event/class-schedule specific about this (unlike utils/
// events.js's own monthGrid, which bins a real event list per day) - a
// calendar's own date math is the only thing it does.
function monthGridDays(year, month) {
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const startWeekday = firstOfMonth.getUTCDay();
  const days = [];
  for (let i = 0; i < startWeekday; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    days.push({ day: d, date: `${year}-${mm}-${dd}` });
  }
  while (days.length % 7 !== 0) days.push(null);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

// Cycles unmarked -> present (green) -> absent (red) -> unmarked again.
// The request only describes the first two clicks explicitly; a 3rd
// click clearing the mark is this file's own addition (an un-doable
// calendar is the only reasonable way to fix a misclick), not something
// literally asked for.
async function toggleAttendance(studentId, date) {
  const existing = await db.prepare('SELECT status FROM family_school_attendance WHERE student_id = ? AND attendance_date = ?').get(studentId, date);
  if (!existing) {
    await db.prepare('INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, ?)').run(studentId, date, 'present');
    return 'present';
  }
  if (existing.status === 'present') {
    await db
      .prepare("UPDATE family_school_attendance SET status = 'absent', updated_at = now_text() WHERE student_id = ? AND attendance_date = ?")
      .run(studentId, date);
    return 'absent';
  }
  await db.prepare('DELETE FROM family_school_attendance WHERE student_id = ? AND attendance_date = ?').run(studentId, date);
  return null;
}

// A real request: "Can take attendance by individual child or select
// family and take attendance that will appear on all individual
// attendance calendars for each child/student." A date only reads as
// present/absent in this aggregate view when EVERY one of the family's
// students shares that exact status for the date - a date where the
// family's own students disagree (or aren't all marked yet) shows
// unmarked here instead of picking one child's status to speak for
// everyone, the same "don't guess, show it plainly" reasoning
// missingMemberIdsForDate's own mixed-status handling uses elsewhere in
// this app. studentIds.length === 0 (no students at all) returns {}
// immediately - nothing to ever fetch.
async function familyAttendanceForMonth(studentIds, year, month) {
  if (studentIds.length === 0) return {};
  const monthStr = String(month).padStart(2, '0');
  const prefix = `${year}-${monthStr}`;
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT student_id, attendance_date, status FROM family_school_attendance WHERE attendance_date LIKE ? AND student_id IN (${placeholders})`)
    .all(`${prefix}-%`, ...studentIds);
  const statusesByDate = {};
  rows.forEach((r) => {
    if (!statusesByDate[r.attendance_date]) statusesByDate[r.attendance_date] = new Set();
    statusesByDate[r.attendance_date].add(r.status);
  });
  const byDate = {};
  const studentCount = new Set(studentIds).size;
  const countByDate = {};
  rows.forEach((r) => {
    countByDate[r.attendance_date] = (countByDate[r.attendance_date] || 0) + 1;
  });
  Object.keys(statusesByDate).forEach((date) => {
    const statuses = statusesByDate[date];
    if (countByDate[date] === studentCount && statuses.size === 1) {
      byDate[date] = [...statuses][0];
    }
  });
  return byDate;
}

// The "Whole Family" aggregate version of attendanceForSchoolYear above
// - a real request: "Pdf and print should show all 12 months, August-
// July 2026-2027," applied to the family-aggregate view the same way it
// applies to one student's own calendar.
async function familyAttendanceForSchoolYear(studentIds, schoolYearStartYear) {
  const SCHOOL_YEAR_MONTHS = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
  const months = [];
  for (let i = 0; i < SCHOOL_YEAR_MONTHS.length; i++) {
    const month = SCHOOL_YEAR_MONTHS[i];
    const year = i < 5 ? schoolYearStartYear : schoolYearStartYear + 1;
    months.push({ year, month, weeks: monthGridDays(year, month), attendanceByDate: await familyAttendanceForMonth(studentIds, year, month) });
  }
  return months;
}

// The same unmarked -> present -> absent -> unmarked cycle
// toggleAttendance uses, applied to every one of the family's students
// at once for the same date - the SAME next status for everyone,
// computed from the family's own current aggregate status for that date
// (familyAttendanceForMonth's own "every student agrees, or it reads as
// unmarked" rule), not each child's own possibly-different status.
async function toggleFamilyAttendance(studentIds, date) {
  if (studentIds.length === 0) return null;
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT student_id, status FROM family_school_attendance WHERE attendance_date = ? AND student_id IN (${placeholders})`)
    .all(date, ...studentIds);
  const statuses = new Set(rows.map((r) => r.status));
  const current = rows.length === studentIds.length && statuses.size === 1 ? [...statuses][0] : null;
  const next = current === 'present' ? 'absent' : current === 'absent' ? null : 'present';

  for (const studentId of studentIds) {
    if (next === null) {
      await db.prepare('DELETE FROM family_school_attendance WHERE student_id = ? AND attendance_date = ?').run(studentId, date);
      continue;
    }
    const existing = await db.prepare('SELECT 1 FROM family_school_attendance WHERE student_id = ? AND attendance_date = ?').get(studentId, date);
    if (existing) {
      await db
        .prepare('UPDATE family_school_attendance SET status = ?, updated_at = now_text() WHERE student_id = ? AND attendance_date = ?')
        .run(next, studentId, date);
    } else {
      await db.prepare('INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, ?)').run(studentId, date, next);
    }
  }
  return next;
}

// --- Teacher Journal (the Teacher Journal subpage - a real request:
// "Add journal/notes entry by date and by student in the family. Full
// edit description typing box. Then a log below showing all entries.") ---

async function journalEntriesForStudent(studentId) {
  return db
    .prepare('SELECT * FROM family_school_journal_entries WHERE student_id = ? ORDER BY entry_date DESC, id DESC')
    .all(studentId);
}

async function getJournalEntry(id) {
  return db.prepare('SELECT * FROM family_school_journal_entries WHERE id = ?').get(id);
}

async function createJournalEntry({ studentId, entryDate, body, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO family_school_journal_entries (student_id, entry_date, body, created_by_account_id) VALUES (?, ?, ?, ?)')
    .run(studentId, entryDate, body, createdByAccountId);
  return info.lastInsertRowid;
}

async function updateJournalEntry(id, { entryDate, body }) {
  await db
    .prepare("UPDATE family_school_journal_entries SET entry_date = ?, body = ?, updated_at = now_text() WHERE id = ?")
    .run(entryDate, body, id);
}

async function deleteJournalEntry(id) {
  await db.prepare('DELETE FROM family_school_journal_entries WHERE id = ?').run(id);
}

// A real request: "Be able to upload images or documents to daily
// learning log." One entry can carry more than one file, so these are
// their own child rows (family_school_journal_attachments), not a
// column on the entry - saveAttachment/ATTACHMENTS_BUCKET above are
// reused as-is, the same shared bucket lesson content attachments
// already use.
async function attachmentsForJournalEntry(journalEntryId) {
  const rows = await db
    .prepare('SELECT * FROM family_school_journal_attachments WHERE journal_entry_id = ? ORDER BY id')
    .all(journalEntryId);
  for (const a of rows) a.url = attachmentUrl(a.file_key);
  return rows;
}

async function getJournalAttachment(id) {
  return db.prepare('SELECT * FROM family_school_journal_attachments WHERE id = ?').get(id);
}

async function addJournalAttachment({ journalEntryId, file }) {
  const fileKey = await saveAttachment(file);
  const info = await db
    .prepare('INSERT INTO family_school_journal_attachments (journal_entry_id, file_key, file_name, content_type) VALUES (?, ?, ?, ?)')
    .run(journalEntryId, fileKey, file.originalname, file.mimetype || null);
  return info.lastInsertRowid;
}

// Removes the DB row AND the stored file itself - same local-disk-vs-
// Storage branching saveAttachment's own existingKey cleanup uses,
// since nothing else in family_school_journal_attachments ever points
// at that same file_key once this row is gone.
async function deleteJournalAttachment(id) {
  const attachment = await getJournalAttachment(id);
  if (!attachment) return;
  await db.prepare('DELETE FROM family_school_journal_attachments WHERE id = ?').run(id);
  const client = createStorageClient();
  if (client) {
    await deleteFile(client, ATTACHMENTS_BUCKET, attachment.file_key);
  } else {
    const filePath = path.join(ATTACHMENT_DIR, attachment.file_key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

// --- Volunteer Hours (its own subpage - a real request: "Family
// school management, add a subpage for volunteer hours. Be able to
// track and add volunteer hours per student and have a log.") A
// family's own self-tracked homeschool volunteer hours - NOT the
// separate co-op-wide Volunteers/Floater system (utils/volunteers.js). ---

async function volunteerHoursForStudent(studentId) {
  return db
    .prepare('SELECT * FROM family_school_volunteer_hours WHERE student_id = ? ORDER BY hour_date DESC, id DESC')
    .all(studentId);
}

async function totalVolunteerHoursForStudent(studentId) {
  const row = await db.prepare('SELECT COALESCE(SUM(hours), 0) AS total FROM family_school_volunteer_hours WHERE student_id = ?').get(studentId);
  return Number(row.total);
}

async function createVolunteerHourEntry({ studentId, hourDate, hours, activityDescription, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO family_school_volunteer_hours (student_id, hour_date, hours, activity_description, created_by_account_id) VALUES (?, ?, ?, ?, ?)')
    .run(studentId, hourDate, hours, activityDescription || null, createdByAccountId);
  return info.lastInsertRowid;
}

async function getVolunteerHourEntry(id) {
  return db.prepare('SELECT * FROM family_school_volunteer_hours WHERE id = ?').get(id);
}

async function deleteVolunteerHourEntry(id) {
  await db.prepare('DELETE FROM family_school_volunteer_hours WHERE id = ?').run(id);
}

// --- Annual Planner (its own subpage - a real request: "Family
// management should also have a subpage called annual planner where
// it is organized by student and you add curriculum under each
// student. Pop up asks for curriculum name, brand, level and price.") ---

// A real request: "Add a dropdown menu for selecting a school year.
// 2026-2027, 2028-2029, 2020-2021 and so on." A school year runs across
// a calendar-year boundary (fall through spring), so "the current one"
// depends on which half of the calendar year it is - July or later
// means the fall term of thisYear-thisYear+1 has already started (or is
// about to); before that, the school year that's still running started
// LAST calendar year.
function currentSchoolYear() {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${startYear + 1}`;
}

// currentSchoolYear is always included in the range regardless of which
// one is actually selected, same "the selected value never drops out of
// its own <select>" rule the Attendance page's own year dropdown already
// follows (routes/parent-family-school.js's own yearOptions).
// A real request: "Annual planner. Year dropdown menu, add the next 20
// years of dates starting with 2030-2031." 2049 (not just currentStart
// + 3) as a hard floor on the upper end guarantees 2030-2031 through
// 2049-2050 - 20 school years - are always offered here, regardless of
// what today's actual date is, on top of the existing near-past/near-
// future coverage around whichever year is actually selected.
function schoolYearOptions(selected) {
  const [currentStart] = currentSchoolYear().split('-').map(Number);
  const [selectedStart] = (selected || currentSchoolYear()).split('-').map(Number);
  const rangeStart = Math.min(selectedStart, currentStart - 5);
  const rangeEnd = Math.max(selectedStart, currentStart + 3, 2049);
  const options = [];
  for (let y = rangeStart; y <= rangeEnd; y++) options.push(`${y}-${y + 1}`);
  return options;
}

async function curriculumForStudent(studentId, schoolYear) {
  if (schoolYear) {
    return db
      .prepare('SELECT * FROM family_school_curriculum_items WHERE student_id = ? AND school_year = ? ORDER BY name COLLATE "C"')
      .all(studentId, schoolYear);
  }
  return db.prepare('SELECT * FROM family_school_curriculum_items WHERE student_id = ? ORDER BY name COLLATE "C"').all(studentId);
}

async function createCurriculumItem({ studentId, name, subject, brand, level, price, schoolYear, createdByAccountId }) {
  const info = await db
    .prepare(
      'INSERT INTO family_school_curriculum_items (student_id, name, subject, brand, level, price, school_year, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(studentId, name, subject || null, brand || null, level || null, price != null && price !== '' ? price : null, schoolYear || null, createdByAccountId);
  return info.lastInsertRowid;
}

async function getCurriculumItem(id) {
  return db.prepare('SELECT * FROM family_school_curriculum_items WHERE id = ?').get(id);
}

async function updateCurriculumItem(id, { name, subject, brand, level, price, schoolYear }) {
  await db
    .prepare(
      'UPDATE family_school_curriculum_items SET name = ?, subject = ?, brand = ?, level = ?, price = ?, school_year = ? WHERE id = ?'
    )
    .run(name, subject || null, brand || null, level || null, price != null && price !== '' ? price : null, schoolYear || null, id);
}

async function deleteCurriculumItem(id) {
  await db.prepare('DELETE FROM family_school_curriculum_items WHERE id = ?').run(id);
}

// --- Weekly Planner v2 (its own subpage - originally a per-student,
// Mon-anchored implicit grid; replaced by a real follow-up request:
// "Add week button. Popup allows you to choose up to 7 dates. And add
// a title such as week 1, week 2 etc. Create and cancel buttons. Then
// it creates a grid with those dates. Add an assignment button. Pop up
// allows you to write subject, title of assignment or dropdown to
// choose an assignment from family management assignments from parent
// created classes. Save, cancel. Buttons... Weekly plan should allow
// you to make a different weekly plan for each student, parent weekly
// plan and family weekly plan." See the weekly_planner_v2 migration's
// own header comment for why the old tables are left in place,
// unused, rather than migrated or dropped. ---

// "Add a filter button. Choose student, choose school year and choose
// week." A week has no school_year column of its own (unlike curriculum
// items) - schoolYear here is derived from the week's own EARLIEST
// chosen date (the same Aug-Jul boundary currentSchoolYear() already
// uses), so the filter never needs the parent to separately tag a
// week with a year that could then contradict its own real dates.
function schoolYearForDate(dateStr) {
  if (!dateStr) return null;
  const [year, month] = dateStr.split('-').map(Number);
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

async function weeksForOwner(familyId, ownerType, studentId) {
  const rows =
    ownerType === 'student'
      ? await db
          .prepare(
            `SELECT w.*, MIN(d.date) AS first_date FROM family_school_weeks w
             LEFT JOIN family_school_week_dates d ON d.week_id = w.id
             WHERE w.family_id = ? AND w.owner_type = 'student' AND w.student_id = ?
             GROUP BY w.id ORDER BY w.created_at DESC, w.id DESC`
          )
          .all(familyId, studentId)
      : await db
          .prepare(
            `SELECT w.*, MIN(d.date) AS first_date FROM family_school_weeks w
             LEFT JOIN family_school_week_dates d ON d.week_id = w.id
             WHERE w.family_id = ? AND w.owner_type = ?
             GROUP BY w.id ORDER BY w.created_at DESC, w.id DESC`
          )
          .all(familyId, ownerType);
  for (const w of rows) w.schoolYear = schoolYearForDate(w.first_date);
  return rows;
}

async function getWeek(id) {
  return db.prepare('SELECT * FROM family_school_weeks WHERE id = ?').get(id);
}

// dates is an array of 1-7 'YYYY-MM-DD' strings, in the order the
// parent picked them - not necessarily chronological, and not
// necessarily a real consecutive calendar week (the whole point of
// "choose up to 7 dates" over the old implicit Mon-Sun grid).
async function createWeek({ familyId, ownerType, studentId, title, dates, createdByAccountId }) {
  const week = await db
    .prepare('INSERT INTO family_school_weeks (family_id, owner_type, student_id, title, created_by_account_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .get(familyId, ownerType, ownerType === 'student' ? studentId : null, title, createdByAccountId);
  for (let i = 0; i < dates.length; i++) {
    await db.prepare('INSERT INTO family_school_week_dates (week_id, date, position) VALUES (?, ?, ?)').run(week.id, dates[i], i);
  }
  return week.id;
}

async function deleteWeek(id) {
  await db.prepare('DELETE FROM family_school_weeks WHERE id = ?').run(id);
}

// A real request: "a label that says the week title with an edit icon
// on it. When you click the edit icon it allows you to edit the week
// such as the dates, title, description." Updates each existing
// family_school_week_dates row IN PLACE by position rather than
// deleting and recreating all of them - that would sever every date's
// own id, which is what family_school_week_assignments.week_date_id
// actually points at, silently orphaning (deleting, via its own ON
// DELETE CASCADE) every assignment on every day even when that day's
// own date didn't change. Only dates beyond the new, shorter list
// (fewer days than before) are genuinely removed - correctly taking
// their own assignments with them, since those days no longer exist at
// all. New dates (a longer list than before) get fresh rows appended.
async function updateWeek(id, { title, description, dates }) {
  await db.prepare('UPDATE family_school_weeks SET title = ?, description = ?, updated_at = now_text() WHERE id = ?').run(title, description || null, id);
  const existing = await db.prepare('SELECT * FROM family_school_week_dates WHERE week_id = ? ORDER BY position').all(id);
  for (let i = 0; i < dates.length; i++) {
    if (existing[i]) {
      await db.prepare('UPDATE family_school_week_dates SET date = ? WHERE id = ?').run(dates[i], existing[i].id);
    } else {
      await db.prepare('INSERT INTO family_school_week_dates (week_id, date, position) VALUES (?, ?, ?)').run(id, dates[i], i);
    }
  }
  for (let i = dates.length; i < existing.length; i++) {
    await db.prepare('DELETE FROM family_school_week_dates WHERE id = ?').run(existing[i].id);
  }
}

async function getWeekDate(id) {
  return db.prepare('SELECT * FROM family_school_week_dates WHERE id = ?').get(id);
}

// The whole grid, ready to render: each chosen date in the order it was
// picked, carrying its own assignments array.
async function weekGrid(weekId) {
  const dates = await db.prepare('SELECT * FROM family_school_week_dates WHERE week_id = ? ORDER BY position, id').all(weekId);
  for (const d of dates) {
    d.assignments = await db.prepare('SELECT * FROM family_school_week_assignments WHERE week_date_id = ? ORDER BY position, id').all(d.id);
    // "Add New Assignment... upload" - a fresh assignment's own optional
    // file, same attachmentUrl() resolution every other Family School
    // Management upload already uses (never a second URL-building rule).
    for (const a of d.assignments) a.fileUrl = attachmentUrl(a.file_key);
  }
  return dates;
}

// "Print should show the whole week on one page clean. Title should be
// the students name and the date range for the week." A single date
// reads as just that one date; several read as "earliest - latest"
// regardless of pick order, since a printed title should read
// chronologically even if the dates weren't picked that way.
function weekDateRangeLabel(dates) {
  if (dates.length === 0) return '';
  const sorted = [...dates].map((d) => d.date).sort();
  if (sorted.length === 1) return formatDateLong(sorted[0]);
  return `${formatDateLong(sorted[0])} - ${formatDateLong(sorted[sorted.length - 1])}`;
}

// A real request: "show a circle graph for each week below the week
// plan that shows percentage of each subject calculated based off the
// subject of the lessons or assignments that are assigned." Flattens
// every date's own .assignments (weekGrid's own shape) and tallies by
// .subject - an assignment added without ever typing one groups under a
// literal "Other" bucket rather than being silently dropped from the
// chart. Shared by both the Parent Portal (editable) and Student Portal
// (read-only) weekly planner pages, and the print/PDF view, so the exact
// same breakdown/rounding is never recomputed three slightly different
// ways.
function subjectBreakdownForGrid(grid) {
  const counts = new Map();
  let total = 0;
  for (const d of grid) {
    for (const a of d.assignments) {
      const subject = (a.subject || '').trim() || 'Other';
      counts.set(subject, (counts.get(subject) || 0) + 1);
      total += 1;
    }
  }
  return Array.from(counts.entries()).map(([subject, count]) => ({
    subject,
    count,
    percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
  }));
}

// "Add two buttons add class assignment and add new assignment... When
// clicking the add new assignment button you can add a fresh and new
// assignment and it will ask title, description, link, upload, grade,
// subject." description/linkUrl/fileKey/fileName/grade are only ever
// set by that "Add New Assignment" dialog - "Add Class Assignment"
// (contentItemId set) leaves them all null, same as before.
async function createWeekAssignment({ weekDateId, subject, title, contentItemId, description, linkUrl, fileKey, fileName, fileMime, grade }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_week_assignments WHERE week_date_id = ?')
    .get(weekDateId);
  const assignment = await db
    .prepare(
      `INSERT INTO family_school_week_assignments
       (week_date_id, subject, title, content_item_id, position, description, link_url, file_key, file_name, file_mime, grade)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(weekDateId, subject || null, title, contentItemId || null, nextPosition, description || null, linkUrl || null, fileKey || null, fileName || null, fileMime || null, grade || null);
  return assignment.id;
}

async function getWeekAssignment(id) {
  return db.prepare('SELECT * FROM family_school_week_assignments WHERE id = ?').get(id);
}

async function deleteWeekAssignment(id) {
  await db.prepare('DELETE FROM family_school_week_assignments WHERE id = ?').run(id);
}

// A real request: "Add edit icon to all weekly planner assignments."
// Same editable fields as the "Add New Assignment" dialog, minus the
// upload (left as-is, same as a class-assignment pick's own
// content_item_id - neither is meant to be swapped out from this
// dialog, just the text fields around it).
async function updateWeekAssignment(id, { subject, title, description, linkUrl, grade }) {
  await db
    .prepare('UPDATE family_school_week_assignments SET subject = ?, title = ?, description = ?, link_url = ?, grade = ? WHERE id = ?')
    .run(subject || null, title, description || null, linkUrl || null, grade || null, id);
}

// "Check boxes next to each assignment." Returns the new state so the
// caller can redirect/respond without a second read.
async function toggleWeekAssignmentComplete(id) {
  const row = await db
    .prepare('UPDATE family_school_week_assignments SET completed = NOT completed WHERE id = ? RETURNING completed')
    .get(id);
  return row ? row.completed : null;
}

// "Check box on each day for teacher to confirm the day is complete" -
// the parent/home-instructor's own independent sign-off, not a rollup
// of that day's own assignment checkboxes.
async function toggleWeekDateComplete(id) {
  const row = await db
    .prepare('UPDATE family_school_week_dates SET completed = NOT completed WHERE id = ? RETURNING completed')
    .get(id);
  return row ? row.completed : null;
}

// A real request: "allow to drag and drop lessons and assignments
// between days." The grid itself has no separate ordering concern across
// days (position only orders assignments WITHIN one day) - a drag just
// reassigns which date's column this assignment belongs to.
async function moveWeekAssignment(assignmentId, newWeekDateId) {
  await db.prepare('UPDATE family_school_week_assignments SET week_date_id = ? WHERE id = ?').run(newWeekDateId, assignmentId);
}

// "Dropdown to choose an assignment from family management assignments
// from parent created classes" - every assignment-type content item
// (not video/text/file) across every class this family has ever
// created, regardless of which student(s) it's assigned to - the
// planner entry this backs isn't itself student-scoped the way a real
// assignment submission is. A real request later added a second source:
// "Assignment/lessons should also show up under weekly planner add
// lessons" for a lesson that references a Lesson Plans library plan
// (source_lesson_plan_id) - its assignment items are virtual (read live
// from lesson_plan_content_items, see contentItemsForReferencedLessonPlan
// above), never rows in family_school_content_items, so they need their
// own query here. Those ids are prefixed 'plan-' (lesson_plan_content_
// items has its own, separately-numbered id sequence - a plain integer
// id could collide with a real family_school_content_items one) so the
// route below can tell which table an id came from, since content_
// item_id on family_school_week_assignments is a real foreign key into
// family_school_content_items only - a plan-sourced pick is saved with
// contentItemId left null (title/subject are still copied over by
// value), the same as "Add New Assignment" already does.
async function assignmentOptionsForFamily(familyId) {
  const own = await db
    .prepare(
      `SELECT ci.id, ci.title, c.class_name FROM family_school_content_items ci
       JOIN family_school_lessons l ON l.id = ci.lesson_id
       JOIN family_school_classes c ON c.id = l.class_id
       WHERE c.family_id = ? AND ci.type IN ('assignment_upload', 'assignment_submission')`
    )
    .all(familyId);
  const fromPlans = await db
    .prepare(
      `SELECT lpci.id, lpci.title, c.class_name FROM lesson_plan_content_items lpci
       JOIN lesson_plans lp ON lp.id = lpci.lesson_plan_id
       JOIN family_school_lessons l ON l.source_lesson_plan_id = lp.id
       JOIN family_school_classes c ON c.id = l.class_id
       WHERE c.family_id = ? AND lp.allow_family_school_use = true AND lpci.type IN ('assignment_upload', 'assignment_submission')`
    )
    .all(familyId);
  const options = [
    ...own.map((r) => ({ id: String(r.id), title: r.title, class_name: r.class_name })),
    ...fromPlans.map((r) => ({ id: `plan-${r.id}`, title: r.title, class_name: r.class_name })),
  ];
  return options.sort((a, b) => a.class_name.localeCompare(b.class_name) || a.title.localeCompare(b.title));
}

// --- Portfolio (its own subpage - a real request: "add a subpage
// called portfolio. This will summarize all family school management
// features for each student and create a visual profile of everything.
// Pdf and print view.") Pulls together every other subpage's own data
// for ONE student into a single bundle - no new tables, just read-only
// aggregation of what classesForStudent/statsForStudent/curriculumFor
// Student/totalVolunteerHoursForStudent/journalEntriesForStudent/
// weeksForOwner+weekGrid+subjectBreakdownForGrid already compute
// elsewhere. recentWeek is this student's own most-recently-created
// Weekly Planner week (if any) - showing every week here would make the
// page unbounded, and "a visual profile" reads as a snapshot, not a
// full history dump (the Weekly Planner subpage itself is still where
// every week lives). ---
// A real request: "Filter buttons should have student dropdown choice
// and school year choice." schoolYear ("YYYY-YYYY", or falsy for the
// portfolio's own long-standing all-time default) narrows the GPA/
// attendance stats (statsForStudent above) and the curriculum list
// (curriculumForStudent already supports this) to that one Aug-Jul
// span.
async function portfolioForStudent(studentId, schoolYear) {
  const student = await db.prepare("SELECT * FROM members WHERE id = ? AND member_type = 'student'").get(studentId);
  if (!student) return null;
  const stats = await statsForStudent(student, schoolYear);
  const curriculum = await curriculumForStudent(studentId, schoolYear);
  const totalVolunteerHours = await totalVolunteerHoursForStudent(studentId);
  const journalEntries = (await journalEntriesForStudent(studentId)).slice(0, 5);
  const weeks = await weeksForOwner(student.family_id, 'student', studentId);
  let recentWeek = null;
  let recentWeekGrid = null;
  let recentWeekSubjectBreakdown = [];
  if (weeks.length > 0) {
    recentWeek = weeks[0];
    recentWeekGrid = await weekGrid(recentWeek.id);
    recentWeekGrid.forEach((d) => { d.dateLabel = formatDateLabel(d.date); });
    recentWeekSubjectBreakdown = subjectBreakdownForGrid(recentWeekGrid);
  }
  return {
    ...stats,
    curriculum,
    totalVolunteerHours,
    journalEntries,
    recentWeek,
    recentWeekGrid,
    recentWeekSubjectBreakdown,
  };
}

// --- Settings (its own subpage - a real request: "Parent can add
// school name, school logo and colors. NC homeschool ID number. The
// school name, logo and colors will be used as the header for all
// family school management pdf pages and printing pages.") One row
// per family, upserted - views/partials/family-school-print-header.ejs
// is the one place every *-print.ejs view reads it back to build its
// own header instead of the hardcoded "Sanford Homeschoolers" logo/
// title every one of those views used to carry on its own. ---
async function getFamilySchoolSettings(familyId) {
  if (!familyId) return null;
  const row = await db.prepare('SELECT * FROM family_school_settings WHERE family_id = ?').get(familyId);
  if (!row) return null;
  return { ...row, logoUrl: attachmentUrl(row.logo_key) };
}

// A real bug report: "the logo the family uploaded is showing broken on
// every pdf for family school management portal." utils/pdfRender.js's
// renderViewToPdf() renders a *-print.ejs view via req.app.render() (no
// real HTTP request - see its own header comment) and hands the
// resulting HTML straight to a headless Chromium page via setContent().
// That page then fetches every relative asset URL - including the
// logo's own <img src>, which is getFamilySchoolSettings()'s own
// logoUrl pointing at the private-bucket proxy route (GET /family-
// school/files/:key) - as a REAL, fresh HTTP request with no session
// cookie at all, since this headless browser was never logged in as
// anyone. requirePortalAuth on that route rejects it (a redirect to
// login, not the image), so the logo always renders broken in a PDF -
// this never showed up on a live page because a real person's own
// browser, loading that same print-preview page in a tab, already has
// their session cookie. Fetches the logo's real bytes here (server-
// side, same account/request that's already authorized to read
// family_school_settings in the first place) and inlines them as a
// data: URI instead, which Chromium can always render with no network
// request or cookie of its own needed - every /download.pdf route
// calls this on its own familySettings right before handing it to
// renderViewToPdf, in place of the live pages' own proxy-URL logoUrl.
async function familySettingsForPdf(settings) {
  if (!settings || !settings.logo_key) return settings;
  const buffer = await attachmentBuffer(settings.logo_key);
  if (!buffer) return settings;
  const mimeType = settings.logo_mime || 'image/png';
  return { ...settings, logoUrl: `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}` };
}

async function saveFamilySchoolSettings({ familyId, schoolName, colorPrimary, colorSecondary, colorText, ncHomeschoolId, homeschooledSince, logoKey, logoMime }) {
  const existing = await db.prepare('SELECT logo_key, logo_mime FROM family_school_settings WHERE family_id = ?').get(familyId);
  const resolvedLogoKey = typeof logoKey !== 'undefined' ? logoKey : existing ? existing.logo_key : null;
  const resolvedLogoMime = typeof logoKey !== 'undefined' ? logoMime || null : existing ? existing.logo_mime : null;
  if (existing) {
    await db
      .prepare(
        `UPDATE family_school_settings
         SET school_name = ?, color_primary = ?, color_secondary = ?, color_text = ?, nc_homeschool_id = ?, homeschooled_since = ?, logo_key = ?, logo_mime = ?, updated_at = now_text()
         WHERE family_id = ?`
      )
      .run(schoolName || null, colorPrimary || null, colorSecondary || null, colorText || null, ncHomeschoolId || null, homeschooledSince || null, resolvedLogoKey, resolvedLogoMime, familyId);
  } else {
    await db
      .prepare(
        `INSERT INTO family_school_settings (family_id, school_name, color_primary, color_secondary, color_text, nc_homeschool_id, homeschooled_since, logo_key, logo_mime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(familyId, schoolName || null, colorPrimary || null, colorSecondary || null, colorText || null, ncHomeschoolId || null, homeschooledSince || null, resolvedLogoKey, resolvedLogoMime);
  }
}

module.exports = {
  CONTENT_ITEM_TYPES,
  attachmentUrl,
  saveAttachment,
  attachmentBuffer,
  attachmentAccessForFamily,
  classesForFamily,
  getClass,
  createClass,
  createClassFromLessonPlan,
  updateClass,
  deleteClass,
  studentsForClass,
  assignClassToStudents,
  classesForStudent,
  lessonsForClass,
  getLesson,
  createLesson,
  updateLesson,
  deleteLesson,
  unlinkLessonFromPlan,
  reorderLessons,
  getContentItem,
  contentItemsForLesson,
  createContentItem,
  updateContentItem,
  deleteContentItem,
  reorderContentItems,
  getLessonItemCompletion,
  markLessonItemComplete,
  getAssignmentSubmission,
  submitAssignment,
  gradeAssignmentSubmission,
  lessonsForStudentView,
  nextContentItemAfter,
  gradesForStudent,
  overviewForFamily,
  monthGridDays,
  attendanceForStudent,
  allAttendanceForStudent,
  attendanceForSchoolYear,
  toggleAttendance,
  familyAttendanceForMonth,
  familyAttendanceForSchoolYear,
  toggleFamilyAttendance,
  journalEntriesForStudent,
  getJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  attachmentsForJournalEntry,
  getJournalAttachment,
  addJournalAttachment,
  deleteJournalAttachment,
  volunteerHoursForStudent,
  totalVolunteerHoursForStudent,
  createVolunteerHourEntry,
  getVolunteerHourEntry,
  deleteVolunteerHourEntry,
  currentSchoolYear,
  schoolYearOptions,
  curriculumForStudent,
  createCurriculumItem,
  getCurriculumItem,
  updateCurriculumItem,
  deleteCurriculumItem,
  weeksForOwner,
  getWeek,
  createWeek,
  updateWeek,
  deleteWeek,
  getWeekDate,
  weekGrid,
  weekDateRangeLabel,
  subjectBreakdownForGrid,
  createWeekAssignment,
  getWeekAssignment,
  updateWeekAssignment,
  deleteWeekAssignment,
  moveWeekAssignment,
  toggleWeekAssignmentComplete,
  toggleWeekDateComplete,
  assignmentOptionsForFamily,
  portfolioForStudent,
  getFamilySchoolSettings,
  familySettingsForPdf,
  saveFamilySchoolSettings,
  schoolYearForDate,
};
