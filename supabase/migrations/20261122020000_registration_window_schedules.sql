-- A real request: "add registration schedule window. Schedule grid
-- should be a dropdown menu with check boxes to select multiple." Schedule
-- Grid used to be a single class_schedule_id column on registration_windows
-- (one grid, or null for "every grid") - this replaces it with a join table,
-- the exact same "singular column -> join table" move
-- 20261031010000_registration_windows_action_types.sql already made for
-- Section (registration_window_sections), so a window can now target
-- several Schedule Grids at once with "none selected means every grid"
-- staying the unrestricted default.
create table if not exists registration_window_schedules (
  window_id integer not null references registration_windows(id) on delete cascade,
  class_schedule_id integer not null references class_schedules(id) on delete cascade,
  primary key (window_id, class_schedule_id)
);
create index if not exists idx_registration_window_schedules_schedule on registration_window_schedules(class_schedule_id);

-- Carry forward any existing single-grid targeting into the new join table
-- before the old column goes away. Guarded by an information_schema check,
-- same reasoning as the section_id migration's own identical guard: this
-- whole file is meant to be safe to replay in full, and a second run would
-- otherwise fail with "column class_schedule_id does not exist" once the
-- first run's own DROP COLUMN below has already removed it.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'registration_windows' and column_name = 'class_schedule_id'
  ) then
    insert into registration_window_schedules (window_id, class_schedule_id)
    select id, class_schedule_id from registration_windows where class_schedule_id is not null
    on conflict (window_id, class_schedule_id) do nothing;
  end if;
end $$;

-- Fully replaced by the join table above - no remaining reader anywhere in
-- the app (utils/registrationWindows.js's own scheduleIdsByWindow takes
-- over every place that used to read this column directly).
alter table registration_windows drop column if exists class_schedule_id;
