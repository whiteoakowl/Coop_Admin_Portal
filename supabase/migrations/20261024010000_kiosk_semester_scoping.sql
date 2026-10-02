-- A real request: "Add a tab in co-op admin portal settings called
-- kiosk. There will be a drop down picker for choosing a semester that
-- the kiosk page and all of its features are linked too. The floater
-- list for that semester, the setup/cleanup, check in, check out... This
-- way the kiosk can be changed each semester seamlessly" - a follow-up
-- confirmed each semester gets a fully separate Floater List and
-- Setup/Cleanup Teams (new semester = blank slate), not a shared
-- structure merely filtered by date range.
alter table volunteer_lists add column if not exists semester_id integer references semesters(id) on delete cascade;
alter table setup_teams add column if not exists semester_id integer references semesters(id) on delete cascade;
alter table task_list_sections add column if not exists semester_id integer references semesters(id) on delete cascade;
-- The day-scoped session log tables (which dates exist, who's suggested
-- for what task on which date) have no team_id/list_id of their own to
-- inherit a semester through - full separation means these need their
-- own semester_id too, or a brand new semester's fresh Setup Teams would
-- still see every past semester's dates mixed into the same date picker.
alter table setup_dates add column if not exists semester_id integer references semesters(id) on delete cascade;
alter table setup_task_assignments add column if not exists semester_id integer references semesters(id) on delete cascade;

-- Attribute whatever already exists today to the most recently created
-- semester (if any) rather than leaving it orphaned under "no semester" -
-- in practice this is the semester currently in active use. Also seeds
-- the new Kiosk Settings tab's own "active semester" picker so a live
-- site doesn't suddenly show an empty Floater List/Setup Teams the
-- moment this migration runs, before an admin has ever opened that tab.
do $$
declare
  latest_semester_id integer;
begin
  select id into latest_semester_id from semesters order by id desc limit 1;
  if latest_semester_id is not null then
    update volunteer_lists set semester_id = latest_semester_id where semester_id is null;
    update setup_teams set semester_id = latest_semester_id where semester_id is null;
    update task_list_sections set semester_id = latest_semester_id where semester_id is null;
    update setup_dates set semester_id = latest_semester_id where semester_id is null;
    update setup_task_assignments set semester_id = latest_semester_id where semester_id is null;
    insert into app_settings (key, value) values ('kiosk_active_semester_id', latest_semester_id::text)
      on conflict (key) do nothing;
  end if;
end $$;

-- volunteer_lists used to be unique on day alone (exactly one Monday
-- list, one Wednesday list, forever) - now one per (day, semester), so a
-- brand new semester gets its own fresh Monday/Wednesday Floater List
-- instead of reusing whatever the previous semester left behind. Same
-- NULL-collapsing trick as orientation_progress's own semester migration
-- (20261012010000_orientation_semesters.sql) for any row still without a
-- semester (a fresh install with no semesters created yet).
alter table volunteer_lists drop constraint if exists volunteer_lists_day_key;
create unique index if not exists idx_volunteer_lists_day_semester on volunteer_lists (day, coalesce(semester_id, -1));

-- Same reasoning for setup_dates/setup_task_assignments - their old plain
-- (day, session_date[, member_id]) primary keys assumed one shared
-- session-date history per day, forever. Primary key columns can't be
-- NULL, so (unlike the plain unique index above) these are dropped
-- entirely in favor of a coalesce-based unique index, same trick.
alter table setup_dates drop constraint if exists setup_dates_pkey;
create unique index if not exists idx_setup_dates_day_semester_date on setup_dates (day, coalesce(semester_id, -1), session_date);

alter table setup_task_assignments drop constraint if exists setup_task_assignments_pkey;
create unique index if not exists idx_setup_task_assignments_day_semester_member_date
  on setup_task_assignments (day, coalesce(semester_id, -1), member_id, session_date);
