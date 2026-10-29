-- A real request: "Family school management portal, family classes.
-- Add a subpage called available lesson plans. Any lesson plans that
-- admin has created and marked shareable with parent portal will show
-- here as cards... Allows you to filter by grade level, and subject."
-- grade_level/subject are the admin-set classification a lesson plan's
-- own "Lesson Plan Details" form now saves (views/partials/lesson-plan-
-- content-manage.ejs) - grade_level reuses the fixed GRADE_LEVELS
-- vocabulary utils/classSchedule.js's own class/student grade fields
-- already use; subject is free text, same convention family_school_
-- curriculum_items.subject and family_school_week_assignments.subject
-- already follow (no fixed list exists app-wide for it). Both nullable -
-- a plan is still a plain internal template until an admin sets these.
-- shareable_with_parents is the new visibility gate itself, defaulting
-- false - every existing plan stays admin/co-op-only (not shown on the
-- new parent-facing catalog) until an admin explicitly opts it in, same
-- "existing behavior unchanged until an admin opts in" rule the sibling
-- lesson_plans_edit_permissions migration's own two columns follow.
alter table lesson_plans add column if not exists grade_level text;
alter table lesson_plans add column if not exists subject text;
alter table lesson_plans add column if not exists shareable_with_parents boolean not null default false;
