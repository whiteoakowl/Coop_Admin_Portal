-- A real request: "Co-op admin portal add a tab called lesson plans. On
-- this page there are the same class settings lesson plan settings and
-- features. Admins can create lessons plans and assign them to a class
-- to be used as an option. Teachers can also still create their own
-- lesson plans like they do now. Once the admin created lesson plan is
-- added to a class it can then be edited by the teacher without changing
-- the main copy admins have on their end. Essentially its like adding a
-- ready made lesson plan template to a class, the teacher can tweak it
-- without changing the original."
--
-- A standalone, reusable template of the same shape class_assignments/
-- lesson_content_items/quiz_questions/quiz_choices already are (see the
-- lesson_content_and_quizzes/lesson_content_assignments/
-- assignment_submissions migrations for how those evolved) - never
-- linked to any one class. "Assign to a class" (routes/admin-lesson-
-- plans.js's own POST .../assign) is a one-time DEEP COPY into real
-- class_assignments/lesson_content_items/quiz_questions/quiz_choices
-- rows, same create* functions every other "add a lesson to a class"
-- path already uses - once copied, there is no ongoing link back to the
-- template at all, so a teacher editing their class's own copy (or an
-- admin editing a template afterward) can never affect the other side.
-- due_date is deliberately not on lesson_plan_content_items - it only
-- ever makes sense once a copy is actually attached to a real class with
-- real students, not on the reusable template itself.
create table if not exists lesson_plans (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists lesson_plan_content_items (
  id integer generated always as identity primary key,
  lesson_plan_id integer not null references lesson_plans(id) on delete cascade,
  type text not null check (type in ('video', 'text', 'file', 'quiz', 'assignment_upload', 'assignment_submission')),
  position integer not null default 0,
  title text,
  video_url text,
  body text,
  file_url text,
  description text,
  attachment_url text,
  attachment_name text,
  points_possible integer,
  created_at text not null default now_text()
);
create index if not exists idx_lesson_plan_content_items_plan on lesson_plan_content_items(lesson_plan_id);

create table if not exists lesson_plan_quiz_questions (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_plan_content_items(id) on delete cascade,
  type text not null check (type in ('multiple_choice', 'short_answer')),
  prompt text not null,
  points_possible numeric not null default 1,
  position integer not null default 0
);
create index if not exists idx_lesson_plan_quiz_questions_content_item on lesson_plan_quiz_questions(content_item_id);

create table if not exists lesson_plan_quiz_choices (
  id integer generated always as identity primary key,
  question_id integer not null references lesson_plan_quiz_questions(id) on delete cascade,
  label text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_lesson_plan_quiz_choices_question on lesson_plan_quiz_choices(question_id);
