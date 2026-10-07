-- A real request: "Student and parent portal you can't click on class
-- lessons to complete them." A quiz content item already has its own
-- "complete" action (submitting it - quiz_attempts). A video/text/file
-- content item had none at all - nothing to click, nothing recorded -
-- so a lesson made only of those could never be marked done by a
-- student (or a parent completing lessons on a child's behalf, same
-- allow_parent_complete_lessons gate the quiz flow already uses). This
-- is that same "Mark Complete" action for the remaining content types,
-- recorded separately from quiz_attempts since a quiz keeps its own
-- richer attempt/score data.
create table if not exists lesson_item_completions (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  completed_at text not null default now_text(),
  unique (content_item_id, student_id)
);
create index if not exists idx_lesson_item_completions_student on lesson_item_completions(student_id);
