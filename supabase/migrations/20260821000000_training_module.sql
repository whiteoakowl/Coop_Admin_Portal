-- Training & Learning module - see utils/training.js for the module's own
-- full design writeup (why lesson progress is keyed to the ATTEMPT, not
-- the assignment; why quiz answers/lesson progress snapshot their own
-- text instead of just joining live; how server-side grading works).
--
-- Follows this schema file's own established conventions throughout
-- (see initial_schema.sql's own header note): `integer generated always
-- as identity primary key`, `text not null default now_text()` for
-- timestamps, plain `integer` 0/1 for flags, `check (... in (...))` for
-- enums.

create table if not exists trainings (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  estimated_minutes integer,
  passing_score integer not null default 80 check (passing_score between 0 and 100),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- Completion Requirements (Training Builder's own configurable section -
  -- see item 12 of the module's design). require_video_completion and
  -- video_completion_threshold together are "watch all required videos";
  -- there's no separate "complete all lessons" flag - that's just what
  -- finishing every required lesson in the outline already means.
  sequential_lessons integer not null default 1,
  require_video_completion integer not null default 1,
  video_completion_threshold integer not null default 95 check (video_completion_threshold between 1 and 100),
  require_retake_after_failure integer not null default 1,
  allow_skipping_lessons integer not null default 0,
  require_manager_approval integer not null default 0,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists training_lessons (
  id integer generated always as identity primary key,
  training_id integer not null references trainings(id) on delete cascade,
  title text not null,
  description text,
  -- Deliberately just a plain text column, not its own lookup table - a
  -- new lesson type is a new value here plus a new branch wherever
  -- utils/training.js switches on it (grading, locking, rendering), not
  -- a schema change. video_url/content below are simply unused for
  -- whichever type doesn't need them.
  type text not null check (type in ('video', 'text', 'quiz')),
  position integer not null default 0,
  required integer not null default 1,
  -- Video lessons: a direct link to an externally-hosted video file,
  -- played through a plain <video> element - see utils/training.js's own
  -- header comment for why this app doesn't host/stream video files
  -- itself.
  video_url text,
  -- Text lessons: the lesson's own instructional content. Also doubles
  -- as an optional supplementary reading block on a video lesson (module
  -- design item 1's own example: "Company Policies - Video + reading").
  content text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_training_lessons_training on training_lessons(training_id);

-- Optional image resources attached to a lesson (module design item
-- "Add images/resources where supported by the existing application") -
-- reuses the exact same imageFileFilter/Storage upload pattern member
-- photos and design images already use (see utils/uploads.js,
-- utils/storage.js), just a new table for what it's attached to.
create table if not exists training_lesson_resources (
  id integer generated always as identity primary key,
  lesson_id integer not null references training_lessons(id) on delete cascade,
  file_path text not null,
  original_name text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_training_lesson_resources_lesson on training_lesson_resources(lesson_id);

-- One row per answer option on a multiple_choice question - "type" lives
-- on the question (below), not here, so a future question type (true/
-- false, multiple-answer) reuses this same options table rather than
-- needing its own.
create table if not exists training_quiz_questions (
  id integer generated always as identity primary key,
  lesson_id integer not null references training_lessons(id) on delete cascade,
  question text not null,
  type text not null default 'multiple_choice' check (type in ('multiple_choice')),
  points integer not null default 1 check (points > 0),
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_training_quiz_questions_lesson on training_quiz_questions(lesson_id);

create table if not exists training_quiz_options (
  id integer generated always as identity primary key,
  question_id integer not null references training_quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_training_quiz_options_question on training_quiz_options(question_id);

-- One row per (training, member) - the individual's own state,
-- deliberately separate from the training definition itself (a member
-- may take the same training multiple times - see training_attempts -
-- and multiple members share the same training rows).
create table if not exists training_assignments (
  id integer generated always as identity primary key,
  training_id integer not null references trainings(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'passed', 'failed', 'retry_required', 'expired')),
  current_lesson_id integer references training_lessons(id) on delete set null,
  assigned_at text not null default now_text(),
  due_at text,
  completed_at text,
  best_score integer,
  latest_score integer,
  attempt_count integer not null default 0,
  unique (training_id, member_id)
);
create index if not exists idx_training_assignments_member on training_assignments(member_id);
create index if not exists idx_training_assignments_training on training_assignments(training_id);

-- One row per attempt at an assignment - never overwritten, so a
-- member's full attempt history (module design item 15) survives every
-- retake. training_title_snapshot/passing_score_snapshot freeze the
-- rule this specific attempt was actually graded under, so an admin
-- editing the training's passing score later can't silently reclassify
-- an already-decided historical attempt (module design item 19).
create table if not exists training_attempts (
  id integer generated always as identity primary key,
  assignment_id integer not null references training_assignments(id) on delete cascade,
  attempt_number integer not null,
  started_at text not null default now_text(),
  completed_at text,
  score integer,
  passed integer,
  passing_score_snapshot integer not null,
  training_title_snapshot text not null,
  created_at text not null default now_text(),
  unique (assignment_id, attempt_number)
);
create index if not exists idx_training_attempts_assignment on training_attempts(assignment_id);

-- Lesson-level state, one row per (attempt, lesson) - keyed to the
-- ATTEMPT rather than the assignment is the whole reason a retake
-- ("Repeat Entire Training") just works: starting attempt 2 means fresh
-- locked/available rows for every lesson, while attempt 1's own progress
-- (including its video-watch history) stays exactly as it was for
-- reporting. lesson_id is ON DELETE SET NULL, not CASCADE - deleting a
-- lesson later must never erase a past attempt's own history of it, so
-- *_snapshot columns carry what the member actually saw regardless of
-- what happens to the live lesson afterward.
create table if not exists training_lesson_progress (
  id integer generated always as identity primary key,
  attempt_id integer not null references training_attempts(id) on delete cascade,
  lesson_id integer references training_lessons(id) on delete set null,
  lesson_title_snapshot text not null,
  lesson_type_snapshot text not null,
  lesson_position_snapshot integer not null,
  lesson_required_snapshot integer not null,
  status text not null default 'locked' check (status in ('locked', 'available', 'in_progress', 'completed')),
  video_started integer not null default 0,
  -- The furthest point (seconds) actually reached via real playback
  -- <timeupdate> events - not just the latest currentTime, so a scrub-to-
  -- the-end doesn't count as having watched the middle. video_percent is
  -- derived from this against video_duration_seconds once known.
  video_max_watched_seconds real not null default 0,
  video_duration_seconds real,
  video_percent integer not null default 0,
  video_completed integer not null default 0,
  video_completed_at text,
  started_at text,
  completed_at text,
  unique (attempt_id, lesson_id)
);
create index if not exists idx_training_lesson_progress_attempt on training_lesson_progress(attempt_id);

-- One row per (attempt, question) - answers belong to the attempt they
-- were submitted under, same historical-fidelity reasoning as lesson
-- progress above. question_id/selected_option_id are ON DELETE SET
-- NULL, never CASCADE, for the same reason: editing/deleting a question
-- after the fact must not corrupt or erase what a member already
-- answered - the *_snapshot columns are the actual record of what was
-- graded.
create table if not exists training_quiz_answers (
  id integer generated always as identity primary key,
  attempt_id integer not null references training_attempts(id) on delete cascade,
  question_id integer references training_quiz_questions(id) on delete set null,
  question_text_snapshot text not null,
  points_possible_snapshot integer not null,
  selected_option_id integer references training_quiz_options(id) on delete set null,
  selected_option_text_snapshot text,
  is_correct integer not null default 0,
  points_earned integer not null default 0,
  created_at text not null default now_text(),
  unique (attempt_id, question_id)
);
create index if not exists idx_training_quiz_answers_attempt on training_quiz_answers(attempt_id);
