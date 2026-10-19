-- A real request: "Parent portal, student portal and main admin portal
-- add a tab called family school management. Under this tab parent can
-- create classed, lessons and assignments and assign these classes to
-- their own students in their family. These classes will then appear
-- under the students portal to work ok and complete. Parents can edit,
-- track and view all of it. Subpage for grades, subapge for parent to
-- take attendance by the date. View a calendar and mark days student is
-- present for school by clicking on the date and it highlights gren. If
-- you click again it becomes red for didn't do school. Subpage for
-- teacher journal. Add journal/notes entry by date and by student in the
-- family. Full edit description typing box. Then a log below showing
-- all entries. These classes are completely seperate from co-op classes
-- and schedules as well as co-op teachers. It has nothing to do with
-- that at all. On main admin the family school management tab simply
-- has settings. Leave settings for that blank for now."
--
-- A fully standalone, family-owned homeschool tracking system -
-- deliberately NOT built on classes/class_staff/class_assignments/
-- lesson_content_items (the co-op's own class/lesson system) at all, per
-- the request's own "nothing to do with that" - every table here is
-- new and only ever reachable through this feature. Mirrors the SHAPE
-- of the co-op's own proven class_assignments/lesson_content_items/
-- lesson_item_completions/assignment_submissions system structurally
-- (same "a lesson has content items of various types; a content item a
-- student can turn work in on tracks its own completion/submission/
-- grade" design, already battle-tested there), not any of its actual
-- tables. Quiz-type content items are deliberately left out of this
-- first pass (never asked for here, and a full quiz editor/attempt/
-- scoring system is a large feature on its own) - video/text/file
-- (lessons) and assignment_upload/assignment_submission (assignments)
-- cover everything the request actually describes.
create table if not exists family_school_classes (
  id integer generated always as identity primary key,
  family_id integer not null references families(id) on delete cascade,
  class_name text not null,
  description text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_family_school_classes_family on family_school_classes(family_id);

-- Which of the family's own students this class has actually been
-- assigned to - "assign these classes to their own students in their
-- family." A class with no rows here yet exists (an admin/parent can
-- build it out first) but shows on no student's own portal until
-- assigned.
create table if not exists family_school_class_students (
  id integer generated always as identity primary key,
  class_id integer not null references family_school_classes(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  created_at text not null default now_text(),
  unique (class_id, student_id)
);
create index if not exists idx_family_school_class_students_student on family_school_class_students(student_id);

-- The "lesson" container (class_assignments' own role in the co-op
-- system) - one class holds several of these, each in turn holding
-- several content items (below). No due_date/points_possible here, same
-- reasoning the co-op's own assignment_submissions migration already
-- settled on: those belong on the individual content item ("assignment"
-- in the parent/student's own wording), not the lesson as a whole.
create table if not exists family_school_lessons (
  id integer generated always as identity primary key,
  class_id integer not null references family_school_classes(id) on delete cascade,
  title text not null,
  description text,
  position integer not null default 0,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_family_school_lessons_class on family_school_lessons(class_id);

-- One lesson can carry several content blocks, same as lesson_content_items
-- in the co-op system - a video link, a text description, a file link
-- (all three read-only "lesson" material), or an assignment_upload
-- (material FOR the student to work from) / assignment_submission (the
-- student's own work handed back in, gradable - see
-- family_school_assignment_submissions below).
create table if not exists family_school_content_items (
  id integer generated always as identity primary key,
  lesson_id integer not null references family_school_lessons(id) on delete cascade,
  type text not null check (type in ('video', 'text', 'file', 'assignment_upload', 'assignment_submission')),
  position integer not null default 0,
  title text,
  video_url text,
  body text,
  file_url text,
  description text,
  attachment_url text,
  attachment_name text,
  points_possible integer,
  due_date text,
  created_at text not null default now_text()
);
create index if not exists idx_family_school_content_items_lesson on family_school_content_items(lesson_id);

-- "Mark Complete" for a video/text/file/assignment_upload content item -
-- same shape as lesson_item_completions. An assignment_submission item
-- tracks its own completion implicitly (having a row in
-- family_school_assignment_submissions below), so never gets one of
-- these.
create table if not exists family_school_lesson_item_completions (
  id integer generated always as identity primary key,
  content_item_id integer not null references family_school_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  completed_at text not null default now_text(),
  unique (content_item_id, student_id)
);
create index if not exists idx_family_school_lesson_item_completions_student on family_school_lesson_item_completions(student_id);

-- One row per student per assignment_submission content item - the
-- student's own uploaded work, gradable by the parent ("parents can
-- edit, track and view all of it" - this is the "Grades" subpage's own
-- source data, read live from here rather than a separate grades table).
-- Re-uploading replaces the file and resets grading, same as the co-op's
-- own assignment_submissions.
create table if not exists family_school_assignment_submissions (
  id integer generated always as identity primary key,
  content_item_id integer not null references family_school_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  file_url text,
  file_name text,
  submitted_at text not null default now_text(),
  status text not null default 'submitted' check (status in ('submitted', 'graded')),
  points_earned numeric,
  grade_letter text,
  feedback text,
  graded_at text,
  unique (content_item_id, student_id)
);
create index if not exists idx_family_school_assignment_submissions_content_item on family_school_assignment_submissions(content_item_id);
create index if not exists idx_family_school_assignment_submissions_student on family_school_assignment_submissions(student_id);

-- "View a calendar and mark days student is present for school by
-- clicking on the date and it highlights green. If you click again it
-- becomes red for didn't do school." One row per student per date - no
-- row at all is the unmarked/default state; present/absent are the only
-- two real marks a parent can set (a 3rd click clears the row back to
-- unmarked - utils/familySchool.js's own toggleAttendance).
create table if not exists family_school_attendance (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  attendance_date text not null,
  status text not null check (status in ('present', 'absent')),
  created_at text not null default now_text(),
  updated_at text not null default now_text(),
  unique (student_id, attendance_date)
);
create index if not exists idx_family_school_attendance_student on family_school_attendance(student_id);

-- "Subpage for teacher journal. Add journal/notes entry by date and by
-- student in the family. Full edit description typing box. Then a log
-- below showing all entries." "Teacher" here is the parent, in their
-- homeschool-teacher capacity - deliberately not reusing the co-op's own
-- instructor_profiles/class_staff "teacher" concept, same "nothing to do
-- with that" separation as everything else in this migration.
create table if not exists family_school_journal_entries (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  entry_date text not null,
  body text not null,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_family_school_journal_entries_student on family_school_journal_entries(student_id, entry_date);
