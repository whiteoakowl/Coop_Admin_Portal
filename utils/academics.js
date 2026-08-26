// Assignments/grading, diplomas, and transcripts - shared by Teacher
// Portal (creating/grading), Student/Parent Portal (viewing), and Main
// Admin (issuing diplomas). See the academic_records migration's own
// header comment for the schema rationale, especially
// student_academic_history's "only written going forward" limitation.
const db = require('../db');
const { formatDateLabel, formatFriendlyTimestamp } = require('./dates');
const { lastNameOf } = require('./members');

async function assignmentsForClass(classId) {
  return db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY due_date IS NULL, due_date DESC, created_at DESC').all(classId);
}

async function getAssignment(id) {
  return db.prepare('SELECT * FROM class_assignments WHERE id = ?').get(id);
}

async function createAssignment({ classId, className, title, description, dueDate, pointsPossible, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO class_assignments (class_id, class_name, title, description, due_date, points_possible, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(classId, className, title, description || null, dueDate || null, pointsPossible || null, createdByAccountId);
  return info.lastInsertRowid;
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

module.exports = {
  assignmentsForClass,
  getAssignment,
  createAssignment,
  gradebookForAssignment,
  saveGrade,
  assignmentsForStudent,
  diplomaForStudent,
  allDiplomas,
  issueDiploma,
  transcriptForStudent,
};
