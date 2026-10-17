-- A real request: "Check box to lock grid to be viewable to members.
-- Check box to be viewable to public on public homepage. If these boxes
-- aren't checked then members or non-members can't register" - two new
-- per-grid (day+semester class_schedules row) visibility flags, read by
-- Parent/Student Portal's own class browsing + registration (members)
-- and the public homepage's new classes showcase (non-members). Every
-- existing grid defaults to visible to members (today's behavior,
-- unchanged) and hidden from the public homepage (nothing was ever
-- shown there before this).
alter table class_schedules add column if not exists visible_to_members integer not null default 1;
alter table class_schedules add column if not exists visible_to_public integer not null default 0;

-- A real request: "Add column and add row buttons" on the Edit Schedule
-- Grids popup - "+ Add Column" grows the shared hour-position count
-- (utils/classSchedule.js's own HOUR_POSITIONS) past its original fixed
-- 4, which every one of these 5 tables had hardcoded as a `between 1 and
-- 4` CHECK (the Class Schedule page's grid, Member Schedules' own
-- write-through cache, Floater's Permanent Jobs, and Playground Check-
-- In's rosters all key off the same shared hour position) - same widen-
-- the-CHECK-rather-than-normalize-the-column pattern as
-- 20261029010000_member_schedules_day_expansion.sql's own day widening,
-- just dropping the upper bound entirely (1 and up) since there's no
-- fixed enum of valid positions the way there is for day-of-week.
alter table class_schedule_hours drop constraint if exists class_schedule_hours_position_check;
alter table class_schedule_hours add constraint class_schedule_hours_position_check check (position >= 1);

alter table classes drop constraint if exists classes_hour_position_check;
alter table classes add constraint classes_hour_position_check check (hour_position >= 1);

alter table member_schedules drop constraint if exists member_schedules_class_number_check;
alter table member_schedules add constraint member_schedules_class_number_check check (class_number >= 1);

alter table permanent_jobs drop constraint if exists permanent_jobs_hour_position_check;
alter table permanent_jobs add constraint permanent_jobs_hour_position_check check (hour_position >= 1);

alter table playground_rosters drop constraint if exists playground_rosters_hour_position_check;
alter table playground_rosters add constraint playground_rosters_hour_position_check check (hour_position >= 1);
