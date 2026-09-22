-- Run this once in the Supabase dashboard's SQL Editor (Project -> SQL
-- Editor -> New query -> paste -> Run) to fix the site crashing after the
-- 2026-09-22 deploy (Lessons/Quizzes, class parent permissions/chat,
-- class filters, Orientation tab).
--
-- Why this is needed: this app only auto-applies supabase/migrations/*.sql
-- to the throwaway in-memory Postgres the test suite uses (see db/index.js -
-- schemaReady runs the migrations there, but is just Promise.resolve() for
-- a real DATABASE_URL). A real Supabase project has to have each new
-- migration file run against it by hand (see MIGRATION.md). The six
-- migration files below were added by the last deploy and were never run
-- against this project, so the newly-deployed code is now querying tables/
-- columns that don't exist yet - that's the crash.
--
-- This combines those six files, in the same order they'd run in
-- automatically, into one script. It is safe to run more than once - the
-- one statement that wasn't naturally idempotent (the admin_username ->
-- author_name rename) is wrapped in a check below.

-- ===== 20260929010000_registration_windows_day_section.sql =====
alter table registration_windows add column if not exists day text check (day in ('monday', 'wednesday'));
alter table registration_windows add column if not exists section_id integer references sections(id) on delete set null;
create index if not exists idx_registration_windows_section on registration_windows(section_id);

-- ===== 20260930010000_class_chat_messages.sql =====
create table if not exists class_chat_messages (
  id integer generated always as identity primary key,
  class_id integer not null references classes(id) on delete cascade,
  admin_username text not null,
  body text not null,
  created_at text not null default now_text()
);
create index if not exists idx_class_chat_messages_class on class_chat_messages(class_id, created_at);

-- ===== 20260930020000_class_age_selection.sql =====
alter table classes add column if not exists numeric_ages text;

-- ===== 20261001010000_lesson_content_and_quizzes.sql =====
alter table class_assignments add column if not exists open_date text;
alter table class_assignments add column if not exists position integer;
with ordered as (
  select id, row_number() over (partition by class_id order by due_date is null, due_date desc, created_at desc) as rn
  from class_assignments
)
update class_assignments c set position = ordered.rn from ordered where ordered.id = c.id and c.position is null;

create table if not exists lesson_content_items (
  id integer generated always as identity primary key,
  assignment_id integer not null references class_assignments(id) on delete cascade,
  type text not null check (type in ('video', 'text', 'file', 'quiz')),
  position integer not null default 0,
  title text,
  video_url text,
  body text,
  file_url text,
  created_at text not null default now_text()
);
create index if not exists idx_lesson_content_items_assignment on lesson_content_items(assignment_id);

create table if not exists quiz_questions (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  type text not null check (type in ('multiple_choice', 'short_answer')),
  prompt text not null,
  points_possible numeric not null default 1,
  position integer not null default 0
);
create index if not exists idx_quiz_questions_content_item on quiz_questions(content_item_id);

create table if not exists quiz_choices (
  id integer generated always as identity primary key,
  question_id integer not null references quiz_questions(id) on delete cascade,
  label text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_quiz_choices_question on quiz_choices(question_id);

create table if not exists quiz_attempts (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  status text not null default 'pending_review' check (status in ('pending_review', 'graded')),
  score_points numeric,
  points_possible numeric not null,
  submitted_at text not null default now_text(),
  graded_at text,
  graded_by_account_id integer references member_accounts(id) on delete set null,
  unique (content_item_id, student_id)
);
create index if not exists idx_quiz_attempts_student on quiz_attempts(student_id);

create table if not exists quiz_answers (
  id integer generated always as identity primary key,
  attempt_id integer not null references quiz_attempts(id) on delete cascade,
  question_id integer not null references quiz_questions(id) on delete cascade,
  choice_id integer references quiz_choices(id) on delete set null,
  answer_text text,
  is_correct integer,
  points_earned numeric,
  unique (attempt_id, question_id)
);
create index if not exists idx_quiz_answers_attempt on quiz_answers(attempt_id);

-- ===== 20261002010000_class_parent_lesson_chat_permissions.sql =====
alter table classes add column if not exists allow_parent_complete_lessons integer not null default 0;
alter table classes add column if not exists allow_parent_chat integer not null default 0;

-- Guarded so this whole script can be re-run safely: the plain
-- "rename column" version fails the second time, once admin_username no
-- longer exists to rename.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'class_chat_messages' and column_name = 'admin_username'
  ) then
    alter table class_chat_messages rename column admin_username to author_name;
  end if;
end $$;

-- ===== 20261003010000_orientation_progress.sql =====
create table if not exists orientation_progress (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  day text not null check (day in ('monday', 'wednesday')),
  video_complete integer not null default 0,
  video_completed_at text,
  meetup_complete integer not null default 0,
  meetup_completed_at text,
  teacher_training_complete integer not null default 0,
  teacher_training_completed_at text,
  tour_complete integer not null default 0,
  tour_completed_at text,
  unique (member_id, day)
);
create index if not exists idx_orientation_progress_member on orientation_progress(member_id);
