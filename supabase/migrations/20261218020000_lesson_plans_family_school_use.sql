-- A real request: "Add allow members to use this lesson plan for
-- Homeschool family management. Lesson should appear on available
-- lesson plans page. Lessons should show up under add preplanned class
-- button... Assignment/lessons should also show up under weekly planner
-- add lessons." A single per-plan visibility flag, off by default (an
-- existing plan never silently becomes visible to Family School
-- Management just because this column now exists) - every surface that
-- lists lesson plans for a Family School Management parent filters on
-- this flag (see utils/lessonPlans.js's own listFamilySchoolLessonPlans).
alter table lesson_plans add column if not exists allow_family_school_use boolean not null default false;
