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
const { todayISO, formatDateLabel, addDays, weekdayOf } = require('./dates');
const { byLastName } = require('./members');
const { createStorageClient, uploadFile, deleteFile, generateKey, publicUrl } = require('./storage');
const { urlForUpload } = require('./uploadBackend');

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

function attachmentUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(ATTACHMENTS_BUCKET, key) : `/uploads/family-school-attachments/${key}`;
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

async function createLesson({ classId, title, description, createdByAccountId }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_lessons WHERE class_id = ?')
    .get(classId);
  const info = await db
    .prepare('INSERT INTO family_school_lessons (class_id, title, description, position, created_by_account_id) VALUES (?, ?, ?, ?, ?)')
    .run(classId, title, description || null, nextPosition, createdByAccountId);
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

async function reorderLessons(classId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.prepare('UPDATE family_school_lessons SET position = ? WHERE id = ? AND class_id = ?').run(i, orderedIds[i], classId);
  }
}

// --- Content items (the lesson/assignment material itself) ---

async function getContentItem(id) {
  return db.prepare('SELECT * FROM family_school_content_items WHERE id = ?').get(id);
}

async function contentItemsForLesson(lessonId) {
  const items = await db.prepare('SELECT * FROM family_school_content_items WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
  return items.map((item) => ({ ...item, attachmentUrl: attachmentUrl(item.attachment_url) }));
}

async function createContentItem({ lessonId, type, title, videoUrl, body, fileUrl, description, attachmentUrl: attachmentKey, attachmentName, pointsPossible, dueDate }) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_content_items WHERE lesson_id = ?')
    .get(lessonId);
  const info = await db
    .prepare(
      `INSERT INTO family_school_content_items (lesson_id, type, position, title, video_url, body, file_url, description, attachment_url, attachment_name, points_possible, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lessonId, type, nextPosition, title || null, videoUrl || null, body || null, fileUrl || null,
      description || null, attachmentKey || null, attachmentName || null, pointsPossible != null ? pointsPossible : null, dueDate || null
    );
  return info.lastInsertRowid;
}

async function updateContentItem(id, { title, videoUrl, body, fileUrl, description, attachmentUrl: attachmentKey, attachmentName, pointsPossible, dueDate }) {
  await db
    .prepare(
      `UPDATE family_school_content_items SET title = ?, video_url = ?, body = ?, file_url = ?, description = ?, attachment_url = ?, attachment_name = ?, points_possible = ?, due_date = ? WHERE id = ?`
    )
    .run(
      title || null, videoUrl || null, body || null, fileUrl || null, description || null,
      attachmentKey || null, attachmentName || null, pointsPossible != null ? pointsPossible : null, dueDate || null, id
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

async function submitAssignment({ contentItemId, studentId, fileUrl, fileName }) {
  await db
    .prepare(
      `INSERT INTO family_school_assignment_submissions (content_item_id, student_id, file_url, file_name, submitted_at, status, points_earned, grade_letter, feedback, graded_at)
       VALUES (?, ?, ?, ?, now_text(), 'submitted', NULL, NULL, NULL, NULL)
       ON CONFLICT (content_item_id, student_id) DO UPDATE SET
         file_url = excluded.file_url, file_name = excluded.file_name, submitted_at = now_text(),
         status = 'submitted', points_earned = NULL, grade_letter = NULL, feedback = NULL, graded_at = NULL`
    )
    .run(contentItemId, studentId, fileUrl, fileName);
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
  if (index === -1 || index === flat.length - 1) return null;
  return flat[index + 1];
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

async function overviewForFamily(familyId) {
  const students = await db
    .prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'student' AND active = 1 ORDER BY name COLLATE \"C\"")
    .all(familyId);
  return Promise.all(
    students.map(async (student) => {
      const classes = await classesForStudent(student.id);
      const classesWithGrades = await Promise.all(
        classes.map(async (cls) => {
          const totals = await db
            .prepare(
              `SELECT COALESCE(SUM(s.points_earned), 0) AS earned, COALESCE(SUM(ci.points_possible), 0) AS possible
               FROM family_school_lessons l
               JOIN family_school_content_items ci ON ci.lesson_id = l.id AND ci.type = 'assignment_submission'
               JOIN family_school_assignment_submissions s ON s.content_item_id = ci.id AND s.student_id = ? AND s.status = 'graded'
               WHERE l.class_id = ?`
            )
            .get(student.id, cls.id);
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
        (await db.prepare("SELECT COUNT(*) AS n FROM family_school_attendance WHERE student_id = ? AND status = 'present'").get(student.id)).n
      );
      return {
        ...student,
        photoUrl: memberPhotoUrl(student.photo_path),
        classes: classesWithGrades,
        gpa,
        presentDays,
        attendanceTargetDays: ATTENDANCE_TARGET_DAYS,
      };
    })
  );
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

// --- Annual Planner (its own subpage - a real request: "Family
// management should also have a subpage called annual planner where
// it is organized by student and you add curriculum under each
// student. Pop up asks for curriculum name, brand, level and price.") ---

async function curriculumForStudent(studentId) {
  return db.prepare('SELECT * FROM family_school_curriculum_items WHERE student_id = ? ORDER BY name COLLATE "C"').all(studentId);
}

async function createCurriculumItem({ studentId, name, brand, level, price, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO family_school_curriculum_items (student_id, name, brand, level, price, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(studentId, name, brand || null, level || null, price != null && price !== '' ? price : null, createdByAccountId);
  return info.lastInsertRowid;
}

async function getCurriculumItem(id) {
  return db.prepare('SELECT * FROM family_school_curriculum_items WHERE id = ?').get(id);
}

async function deleteCurriculumItem(id) {
  await db.prepare('DELETE FROM family_school_curriculum_items WHERE id = ?').run(id);
}

// --- Schedule Planner (its own subpage - a real request: "The other
// new planner page under family school management should be called
// schedule planner." Its own per-week spreadsheet grid, with a real
// decision behind its shape:
// "View weekly plan grid for each student. Be able to add rows and
// columns to create plan grid for the week per student," confirmed to
// mean one independently-editable grid per student PER CALENDAR WEEK,
// stepped through with Prev/Next the same way family_school_attendance's
// own calendar already is - not one single reusable template.) ---

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Always that week's own Monday, regardless of which day of the week
// `dateIso` itself falls on - the Weekly Plan page's own Prev/Next
// buttons step a whole week at a time from here, same as
// family_school_attendance's own month math.
function mondayOf(dateIso) {
  const weekday = weekdayOf(dateIso); // 0=Sun..6=Sat (utils/dates.js's own weekdayOf)
  return addDays(dateIso, weekday === 0 ? -6 : 1 - weekday);
}

async function getWeeklyPlan(studentId, weekStartDate) {
  return db.prepare('SELECT * FROM family_school_weekly_plans WHERE student_id = ? AND week_start_date = ?').get(studentId, weekStartDate);
}

async function getWeeklyPlanById(id) {
  return db.prepare('SELECT * FROM family_school_weekly_plans WHERE id = ?').get(id);
}

async function getWeeklyPlanColumn(id) {
  return db.prepare('SELECT * FROM family_school_weekly_plan_columns WHERE id = ?').get(id);
}

async function getWeeklyPlanRow(id) {
  return db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE id = ?').get(id);
}

// Lazily creates the plan row the first time this student's grid for
// this particular week is ever opened, seeded with one column per
// actual day of that week (Monday through Sunday, labeled by weekday
// name) as a sensible starting point - rows start empty (a parent's own
// subjects/periods, not something to guess), and a parent can still add
// to or delete from the seeded columns same as any other.
async function getOrCreateWeeklyPlan(studentId, weekStartDate) {
  const existing = await getWeeklyPlan(studentId, weekStartDate);
  if (existing) return existing;
  const info = await db.prepare('INSERT INTO family_school_weekly_plans (student_id, week_start_date) VALUES (?, ?)').run(studentId, weekStartDate);
  const planId = info.lastInsertRowid;
  for (let i = 0; i < 7; i++) {
    const dayIso = addDays(weekStartDate, i);
    await db.prepare('INSERT INTO family_school_weekly_plan_columns (plan_id, label, position) VALUES (?, ?, ?)').run(planId, WEEKDAY_NAMES[weekdayOf(dayIso)], i);
  }
  return { id: planId, student_id: studentId, week_start_date: weekStartDate };
}

// The whole grid, ready to render: columns in order, each row in order
// carrying its own cells array already lined up one-to-one with
// `columns` (a cell with no saved content yet is just '').
async function weeklyPlanGrid(studentId, weekStartDate) {
  const plan = await getOrCreateWeeklyPlan(studentId, weekStartDate);
  const columns = await db.prepare('SELECT * FROM family_school_weekly_plan_columns WHERE plan_id = ? ORDER BY position, id').all(plan.id);
  const rows = await db.prepare('SELECT * FROM family_school_weekly_plan_rows WHERE plan_id = ? ORDER BY position, id').all(plan.id);
  const cells =
    rows.length > 0
      ? await db.prepare(`SELECT * FROM family_school_weekly_plan_cells WHERE row_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.id))
      : [];
  const contentByKey = {};
  for (const c of cells) contentByKey[`${c.row_id}:${c.column_id}`] = c.content;
  return {
    planId: plan.id,
    columns,
    rows: rows.map((r) => ({ ...r, cells: columns.map((c) => ({ columnId: c.id, content: contentByKey[`${r.id}:${c.id}`] || '' })) })),
  };
}

async function addWeeklyPlanColumn(planId, label) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_weekly_plan_columns WHERE plan_id = ?')
    .get(planId);
  await db.prepare('INSERT INTO family_school_weekly_plan_columns (plan_id, label, position) VALUES (?, ?, ?)').run(planId, label, nextPosition);
}

async function addWeeklyPlanRow(planId, label) {
  const { next_position: nextPosition } = await db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM family_school_weekly_plan_rows WHERE plan_id = ?')
    .get(planId);
  await db.prepare('INSERT INTO family_school_weekly_plan_rows (plan_id, label, position) VALUES (?, ?, ?)').run(planId, label, nextPosition);
}

async function deleteWeeklyPlanColumn(id) {
  await db.prepare('DELETE FROM family_school_weekly_plan_columns WHERE id = ?').run(id);
}

async function deleteWeeklyPlanRow(id) {
  await db.prepare('DELETE FROM family_school_weekly_plan_rows WHERE id = ?').run(id);
}

async function setWeeklyPlanCell(rowId, columnId, content) {
  await db
    .prepare(
      `INSERT INTO family_school_weekly_plan_cells (row_id, column_id, content, updated_at) VALUES (?, ?, ?, now_text())
       ON CONFLICT (row_id, column_id) DO UPDATE SET content = excluded.content, updated_at = now_text()`
    )
    .run(rowId, columnId, content || null);
}

module.exports = {
  CONTENT_ITEM_TYPES,
  attachmentUrl,
  saveAttachment,
  classesForFamily,
  getClass,
  createClass,
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
  toggleAttendance,
  journalEntriesForStudent,
  getJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  curriculumForStudent,
  createCurriculumItem,
  getCurriculumItem,
  deleteCurriculumItem,
  mondayOf,
  getWeeklyPlanById,
  getWeeklyPlanColumn,
  getWeeklyPlanRow,
  weeklyPlanGrid,
  addWeeklyPlanColumn,
  addWeeklyPlanRow,
  deleteWeeklyPlanColumn,
  deleteWeeklyPlanRow,
  setWeeklyPlanCell,
};
