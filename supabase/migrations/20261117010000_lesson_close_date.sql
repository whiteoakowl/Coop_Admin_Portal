-- A real request: "add a close date to lesson details." class_assignments
-- ("Lessons" in the UI - see 20261001010000_lesson_content_and_quizzes.sql's
-- own comment) already has open_date (a lesson is locked/hidden before it)
-- and due_date (informational only, shown to students/parents, never
-- enforced); close_date is the symmetric hard cutoff on the other end - once
-- past, utils/academics.js's lessonsForStudentView locks the lesson again,
-- the same way an unopened one already is.
alter table class_assignments add column if not exists close_date text;
