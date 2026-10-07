-- A real request: "class settings, registration schedule window. Open
-- for options, parents can register for teaching positions, parents can
-- register for class assistant positions, parents can register their
-- students for classes, students can register for classes... Also keep
-- choosing schedule grid but now it will have the options of the class
-- schedule titles that have been created to connect them to." Replaces
-- the generic role_key "Open For" dropdown with four specific action-type
-- toggles (none checked = open for every action, same "empty means
-- unrestricted" convention registration_windows has always used), and
-- the plain day_check'd `day` column (only ever 'monday'/'wednesday',
-- never widened for the later 7-day expansion) with a real FK to
-- class_schedules - the Schedule Grid picker now offers that catalog's
-- own admin-given titles instead of a hardcoded day list. `section_id`
-- (always just ONE section) becomes a real join table so a window can
-- target several sections at once - "section if none are selected it
-- will be open to everyone... if a section is selected it will also
-- block anyone not in those sections."
alter table registration_windows add column if not exists class_schedule_id integer references class_schedules(id) on delete set null;
alter table registration_windows add column if not exists open_for_parent_teacher boolean not null default false;
alter table registration_windows add column if not exists open_for_parent_assistant boolean not null default false;
alter table registration_windows add column if not exists open_for_parent_register_student boolean not null default false;
alter table registration_windows add column if not exists open_for_student_register_self boolean not null default false;
create index if not exists idx_registration_windows_class_schedule on registration_windows(class_schedule_id);

create table if not exists registration_window_sections (
  window_id integer not null references registration_windows(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (window_id, section_id)
);
create index if not exists idx_registration_window_sections_section on registration_window_sections(section_id);

-- Carry forward any existing single-section targeting into the new join
-- table before the old column goes away. Guarded by an information_
-- schema check (same real bug report as 20261005010000_store_option_
-- groups.sql's own identical guard: running this whole consolidated file
-- a second time - it's meant to be safe to replay in full - failed with
-- "column section_id does not exist", since the first run's own DROP
-- COLUMN below already removed it by the time this INSERT's query was
-- re-parsed).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'registration_windows' and column_name = 'section_id'
  ) then
    insert into registration_window_sections (window_id, section_id)
    select id, section_id from registration_windows where section_id is not null
    on conflict (window_id, section_id) do nothing;
  end if;
end $$;

-- role_key (the old generic "Open For" role dropdown) and day (the
-- never-widened 'monday'/'wednesday'-only column) are both fully
-- replaced above - no remaining reader anywhere in the app.
alter table registration_windows drop column if exists role_key;
alter table registration_windows drop column if exists day;
alter table registration_windows drop column if exists section_id;
