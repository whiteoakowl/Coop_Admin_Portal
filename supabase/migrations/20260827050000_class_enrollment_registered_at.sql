-- A real request: "on class rosters each student member line should
-- have registration date/time." class_enrollments never tracked when a
-- student was actually added to a class - just the (class_id,
-- student_id) pair itself. Existing rows backfill to the migration's own
-- run time (there's no way to recover their real add date), but every
-- enrollment from here forward gets a real timestamp.
alter table class_enrollments add column if not exists created_at text not null default now_text();
