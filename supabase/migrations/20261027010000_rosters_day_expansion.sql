-- Phase 3 of the 7-day expansion ("Full 7 day expansion so... attendance...
-- will work for years to come" - a real request). Phase 1 (20261025010000)
-- let the Classes grid offer any day of the week; Phase 2 (20261026010000)
-- widened Volunteers/Setup-Cleanup's own day columns the same way.
-- Attendance/Rosters (routes/admin-rosters.js) is the last of the four
-- pages the original combo-picker request named - its own Playground
-- check-in log and term-end Archive snapshot were still capped at
-- 'monday'/'wednesday' only, so activating e.g. Tuesday in Day Settings
-- made Tuesday's Parent/Student grid work but 500'd on its own Playground
-- slots and its own end-of-term Archive.
alter table playground_rosters drop constraint if exists playground_rosters_day_check;
alter table playground_rosters add constraint playground_rosters_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table roster_archives drop constraint if exists roster_archives_day_check;
alter table roster_archives add constraint roster_archives_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));
