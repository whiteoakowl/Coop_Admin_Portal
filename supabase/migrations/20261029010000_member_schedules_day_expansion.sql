-- Phase 3 of the 7-day expansion, Member Schedules. Unlike every other
-- :day-scoped table this expansion touched, member_schedule_archives
-- wasn't just missing a wider CHECK constraint - it had two fixed
-- columns, monday_schedule/wednesday_schedule, baked into its own shape
-- for exactly two days. Rather than rewrite those into a normalized child
-- table (a much bigger, riskier migration for existing archived data),
-- this adds one generic column that holds every active day's own summary
-- as JSON ({"monday": "...", "tuesday": "...", ...}, utils/schedule.js's
-- archiveMemberSchedules) - monday_schedule/wednesday_schedule stay as
-- they are, read-only now, so every archive made before this migration
-- keeps reading back exactly as it always has (see
-- listMemberScheduleArchives' own comment on how the two shapes are
-- merged for display).
alter table member_schedule_archives add column if not exists day_schedules_json text;

-- member_schedules (the write-through cache utils/classSchedule.js's own
-- syncMemberSchedulesForDay keeps in sync whenever class hours/enrollment/
-- staffing change - routes/admin-class-schedule.js's Edit Hours among its
-- callers) had the same 2-day-only CHECK constraint class_schedule_archives
-- did - editing a newly-activated day's own Class Hours 500'd outright.
alter table member_schedules drop constraint if exists member_schedules_day_check;
alter table member_schedules add constraint member_schedules_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));
