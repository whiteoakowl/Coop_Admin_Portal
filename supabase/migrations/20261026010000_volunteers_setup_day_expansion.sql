-- Phase 2 of the 7-day expansion ("Full 7 day expansion so multiple
-- semesters can be created and managed... all the floater and setup
-- cleanup features for each to go with it" - a real request). Phase 1
-- (20261025010000) let the Classes grid offer any day of the week via a
-- new class_schedules catalog; this widens Volunteers (Floater
-- Assignments) and Setup/Cleanup's own day columns the same way, so a day
-- added there (e.g. Tuesday) can also get its own Floater List and
-- Setup/Cleanup Teams. Both systems already gained semester_id in
-- 20261024010000 (Kiosk settings) - only the day value itself was still
-- capped at 'monday'/'wednesday'.
alter table volunteer_lists drop constraint if exists volunteer_lists_day_check;
alter table volunteer_lists add constraint volunteer_lists_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table setup_teams drop constraint if exists setup_teams_day_check;
alter table setup_teams add constraint setup_teams_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table task_list_sections drop constraint if exists task_list_sections_day_check;
alter table task_list_sections add constraint task_list_sections_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table setup_dates drop constraint if exists setup_dates_day_check;
alter table setup_dates add constraint setup_dates_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table setup_task_assignments drop constraint if exists setup_task_assignments_day_check;
alter table setup_task_assignments add constraint setup_task_assignments_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));
