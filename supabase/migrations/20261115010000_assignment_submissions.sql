-- A real request: "When creating assignments for classes there should be
-- a assignment submit option. Where i can add a title, description,
-- points, grade and the student will see an upload link. The lesson
-- itself should not have points. Points can be attached to each
-- assignment instead." A new lesson_content_items type
-- ('assignment_submission', distinct from the existing 'assignment_upload'
-- type which is ADMIN posting materials TO students - this one is a
-- STUDENT uploading their own work back) carries its own points_possible;
-- the lesson (class_assignments) itself keeps its own points_possible
-- column for any already-created lesson that still has one, but the
-- Lesson Details/New Lesson forms no longer collect it.

alter table lesson_content_items add column if not exists points_possible integer;

alter table lesson_content_items drop constraint if exists lesson_content_items_type_check;
alter table lesson_content_items add constraint lesson_content_items_type_check
  check (type in ('video', 'text', 'file', 'quiz', 'assignment_upload', 'assignment_submission'));

-- A real request: "Due dates should be on the assignments, not on the
-- lesson." The lesson (class_assignments) keeps its own due_date column
-- for any already-created lesson that still has one, but new/edited
-- lessons no longer collect it - each content item ("assignment" in the
-- Parent/Student portal's own wording) carries its own instead.
alter table lesson_content_items add column if not exists due_date text;

-- One row per student per assignment_submission content item - re-
-- uploading replaces the file and resets grading (status back to
-- 'submitted', grade fields cleared) so the teacher/admin knows to
-- re-review. "a letter/percentage grade field for after review" (a real
-- clarification) - grade_letter is free text (e.g. "A-", "92%"), separate
-- from the numeric points_earned.
create table if not exists assignment_submissions (
  id serial primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  file_url text,
  file_name text,
  submitted_at timestamptz not null default now(),
  status text not null default 'submitted' check (status in ('submitted', 'graded')),
  points_earned numeric,
  grade_letter text,
  feedback text,
  graded_at timestamptz,
  unique (content_item_id, student_id)
);

create index if not exists idx_assignment_submissions_content_item on assignment_submissions(content_item_id);
create index if not exists idx_assignment_submissions_student on assignment_submissions(student_id);
