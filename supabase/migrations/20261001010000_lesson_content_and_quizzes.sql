-- A real request: "Classes, lessons. Button to add lessons. Could be
-- link to video, text description, file link, quiz with scoring. Setup
-- as lesson title with drop down of the different links and activities.
-- Be able to reorder, assignments or lessons, drag and drop, due dates,
-- open dates, Co-op admin and teacher dashboard have controls. Parent
-- and student portal can view the classes and interact." Follow-up
-- questions confirmed: quizzes mix multiple-choice (auto-scored) and
-- short-answer (teacher/admin reviews before the score is final), and
-- quiz-taking is student-only (parent can view, never submit).
--
-- class_assignments IS "lessons" now (renamed in the UI a task ago,
-- table name kept - see that migration's own comment on why nothing
-- here is a parallel table). open_date/position are new; everything
-- else about the lesson itself is unchanged.
alter table class_assignments add column if not exists open_date text;
alter table class_assignments add column if not exists position integer;
-- Backfill: every existing lesson gets a position ordered by its old
-- default sort (due date, then newest first) so drag-reorder has a
-- stable starting order instead of every row tying at NULL.
with ordered as (
  select id, row_number() over (partition by class_id order by due_date is null, due_date desc, created_at desc) as rn
  from class_assignments
)
update class_assignments c set position = ordered.rn from ordered where ordered.id = c.id and c.position is null;

-- One lesson can carry several content blocks - a video link, a text
-- description, a file link, and/or a quiz - each its own row so a
-- lesson isn't limited to one of each, and so reordering blocks within
-- a lesson (drag and drop) doesn't need to touch class_assignments
-- itself.
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

-- A quiz content item's own questions - multiple_choice (auto-scored
-- against quiz_choices.is_correct) or short_answer (free text, scored
-- by hand - see quiz_answers.points_earned staying null until a
-- teacher/admin reviews it).
create table if not exists quiz_questions (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  type text not null check (type in ('multiple_choice', 'short_answer')),
  prompt text not null,
  points_possible numeric not null default 1,
  position integer not null default 0
);
create index if not exists idx_quiz_questions_content_item on quiz_questions(content_item_id);

-- Only meaningful for a multiple_choice question - a short_answer
-- question has no rows here at all.
create table if not exists quiz_choices (
  id integer generated always as identity primary key,
  question_id integer not null references quiz_questions(id) on delete cascade,
  label text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_quiz_choices_question on quiz_choices(question_id);

-- One row per student per quiz (single-attempt, same "no history, just
-- the current state" shape assignment_grades already uses) - status
-- stays 'pending_review' as long as ANY of this attempt's short_answer
-- answers hasn't been scored yet, flips to 'graded' (and score_points
-- gets its final total) the moment every one of them has. A pure-
-- multiple-choice quiz is 'graded' immediately at submission.
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

-- What the student actually answered, one row per question in their
-- attempt. choice_id is set for a multiple_choice answer (and
-- is_correct/points_earned are filled in immediately, auto-scored
-- against quiz_choices); answer_text is set for a short_answer one
-- (is_correct/points_earned stay null until reviewed).
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
