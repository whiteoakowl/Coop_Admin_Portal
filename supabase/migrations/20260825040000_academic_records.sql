-- Lessons/assignments/grading, diplomas, and transcripts - the last of
-- Track A's originally-scoped platform work (see PLATFORM_BUILD.md).
-- Reuses the EXISTING classes/class_enrollments/class_staff model
-- throughout; nothing here is a parallel course system.

-- A teacher's own assignment for one of their classes (class_staff
-- already governs who "owns" a class - see routes/teacher-portal.js).
-- class_name is a snapshot taken at creation, not a live join to
-- classes.class_name - the same "flatten to plain text, drop the
-- FK-linked detail" reasoning class_schedule_archives already documents,
-- needed here for the same reason: archiving a class deletes the live
-- `classes` row, and an assignment's grades are exactly the kind of
-- record a transcript needs to survive that. class_id itself is kept
-- (ON DELETE SET NULL, not CASCADE) only as a live-class convenience
-- lookup for the teacher's own gradebook; nothing reads it once the
-- class is gone.
create table if not exists class_assignments (
  id integer generated always as identity primary key,
  class_id integer references classes(id) on delete set null,
  class_name text not null,
  title text not null,
  description text,
  due_date text,
  points_possible integer,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_class_assignments_class on class_assignments(class_id);

-- One row per student per assignment, upserted from the teacher's
-- gradebook screen. points_earned/feedback both null until graded - an
-- assignment existing doesn't imply every enrolled student has a row.
create table if not exists assignment_grades (
  id integer generated always as identity primary key,
  assignment_id integer not null references class_assignments(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  points_earned numeric,
  feedback text,
  graded_at text,
  graded_by_account_id integer references member_accounts(id) on delete set null,
  unique (assignment_id, student_id)
);
create index if not exists idx_assignment_grades_student on assignment_grades(student_id);

-- Issued once per student by a Main Admin. Re-issuing just updates the
-- existing row (unique on student_id) rather than accumulating history -
-- a student only ever has the one, current diploma.
create table if not exists diplomas (
  id integer generated always as identity primary key,
  student_id integer not null unique references members(id) on delete cascade,
  title text not null default 'Diploma of Completion',
  issued_date text not null,
  body_text text,
  issued_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);

-- A per-student snapshot of a class taken to completion, written once by
-- archiveClasses (utils/classSchedule.js) at the moment a class is
-- archived - the ONLY source of past-term transcript data, since
-- archiving already deletes the live class (and cascades away its
-- class_enrollments rows) as part of the same operation. Terms archived
-- before this migration existed have no reconstructable history, the
-- same limitation class_schedule_archives itself already has for
-- pre-existing archived classes.
create table if not exists student_academic_history (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  class_name text not null,
  day text,
  age_group text,
  teacher_names text,
  term_ended_at text not null default now_text()
);
create index if not exists idx_student_academic_history_student on student_academic_history(student_id);
