-- A real request: "Co-op admin portal. Lesson plans tab. Click on an
-- existing lesson plan and there is a button called assign to class.
-- Change this button to say Edit settings. Click this button and the
-- new page allows you change lesson plan settings... allow teachers to
-- edit/add to the lesson plan, all members to edit/add to the lesson
-- plan." Genuinely new ground - unlike `locked` (lesson_plans_locked
-- migration), there was no path anywhere in the app for a non-admin to
-- edit a lesson_plans/lesson_plan_content_items row directly before this;
-- these two columns record the admin's intent (the Settings page this
-- migration backs), ready for whichever teacher/member-facing surface
-- is built to actually read them. Both default false - today's existing
-- behavior (admin-only editing) is unchanged until an admin opts a
-- specific lesson plan in.
alter table lesson_plans add column if not exists allow_teacher_edit boolean not null default false;
alter table lesson_plans add column if not exists allow_member_edit boolean not null default false;
