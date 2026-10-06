-- A real request: "add/edit class schedule grid button on the class
-- schedule page. When you click this button it opens a pop up to allow
-- you to create a new schedule grid, choose a semester/day, choose
-- column titles and row titles" - a follow-up confirmed each semester/
-- day combo gets its own independent set of row (room) and column
-- (hour) titles, same as the Classes grid's other per-semester data.
--
-- Hours stay exactly 4 per day (unchanged) - only lifting the day-only
-- scoping to day+semester, same NULL-collapsing trick as every other
-- semester migration (20261024010000_kiosk_semester_scoping.sql, etc.):
-- an existing row keeps semester_id null (the shared/legacy "No
-- Semester" bucket every day already has from before this migration),
-- and that bucket doubles as the fallback a semester without its own
-- customized hours reads from (see utils/classSchedule.js's own
-- hoursForDay) - no backfill needed, nothing changes until an admin
-- explicitly customizes a specific semester's hours via the new popup.
alter table class_schedule_hours add column if not exists semester_id integer references semesters(id) on delete cascade;
alter table class_schedule_hours drop constraint if exists class_schedule_hours_day_position_key;
create unique index if not exists idx_class_schedule_hours_day_semester_position on class_schedule_hours (day, coalesce(semester_id, -1), position);

-- Rooms were never a real table before this - just whatever string was
-- typed into a class's own Room field, with only a day-scoped display-
-- order setting (app_settings, see getRoomOrder/saveRoomOrder). This is
-- the first real, admin-authored room list - semester+day scoped like
-- class_schedule_hours above - but it's purely additive: roomGridForDay
-- still falls back to deriving rooms from live classes (today's exact
-- behavior) for any (day, semester) combo that has no rows here yet.
create table if not exists class_schedule_rooms (
  id integer generated always as identity primary key,
  day text not null check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday')),
  semester_id integer references semesters(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at text not null default now_text()
);
create unique index if not exists idx_class_schedule_rooms_day_semester_name on class_schedule_rooms (day, coalesce(semester_id, -1), lower(name));
