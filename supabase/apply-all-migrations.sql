-- Run this once in the Supabase dashboard's SQL Editor (Project -> SQL
-- Editor -> New query -> paste -> Run) to bring your live database fully
-- up to date with this app's code.
--
-- Every *.sql file in supabase/migrations/, concatenated in the same
-- chronological order the app itself applies them locally/in tests (see
-- db/index.js's allMigrationSql()). This app auto-applies migrations only
-- to its own throwaway/local database - a real Supabase project has
-- always needed each one run by hand (see MIGRATION.md) - and it turned
-- out a much larger backlog of these had never actually been applied here
-- than the single most-recent batch first suspected (the "column
-- image_key does not exist" error was migration 20260923010000, from
-- weeks before tonight).
--
-- SAFE TO RUN MORE THAN ONCE. Every migration in this app is deliberately
-- written idempotently (create table/add column "if not exists", drop-
-- then-recreate for constraints, "on conflict do nothing" for seed data)
-- specifically because this same file replays in full against the local
-- dev/test database on every boot - so running this whole script now,
-- regardless of how much of it your database already has, will only ever
-- apply what's actually missing and leave the rest untouched.

-- ===== 20260811035644_initial_schema.sql =====
-- SH Check-in/out schema - Postgres/Supabase translation of db/schema.sql
-- (the original SQLite schema, kept in place and unchanged as long as the
-- app still runs on it during the migration - see MIGRATION.md).
--
-- Translation notes (apply throughout this file, not repeated per table):
--   - `INTEGER PRIMARY KEY AUTOINCREMENT` -> `integer generated always as
--     identity primary key`. Kept as 32-bit `integer` (not `bigint`/
--     `bigserial`) to match the id range the app already assumes
--     (parseInt() on route params, etc.) - there is no realistic path to
--     2 billion rows in any table here.
--   - `datetime('now')` -> `now_text()`, a small helper defined below that
--     reproduces SQLite's exact `'YYYY-MM-DD HH:MM:SS'` (UTC, no
--     timezone suffix) output. utils/dates.js's formatTimestamp/
--     formatFriendlyTimestamp parse that exact shape (`new
--     Date(sqlTimestamp.replace(' ', 'T') + 'Z')`) - matching it exactly
--     means every timestamp-formatting call site in the app needs no
--     changes at all.
--   - 0/1 flag columns (active, archived, is_primary_parent, the portal_*
--     columns, is_override, source-as-'auto'/'manual' aside) stay
--     `integer`, not `boolean` - the app compares them with `=== 1`/
--     `WHERE x = 1` throughout, and there's no benefit to a real boolean
--     type worth touching every one of those call sites for.
--   - epoch-millisecond columns (check_in_time, check_out_time,
--     sessions.expires_at) become `bigint`, not `integer` - SQLite's
--     dynamically-typed INTEGER holds these fine, but Date.now()-sized
--     values (~1.7 trillion right now) overflow Postgres's 4-byte
--     `integer` (max ~2.1 billion). Every other INTEGER column here is a
--     small id/flag/position value and stays plain `integer`.
--   - `CREATE TABLE IF NOT EXISTS`, `CHECK(...)`, `REFERENCES ... ON
--     DELETE CASCADE/SET NULL`, composite `PRIMARY KEY (a, b)`,
--     `UNIQUE(...)`, and partial `CREATE UNIQUE INDEX ... WHERE ...` are
--     all supported identically in Postgres - ported unchanged.

-- Reproduces SQLite's `datetime('now')`: UTC, 'YYYY-MM-DD HH:MM:SS', no
-- timezone suffix. IMMUTABLE would be wrong here (it's not - it depends on
-- the current time), so left unmarked (STABLE is the correct, and default,
-- volatility for something that reads now()).
create or replace function now_text() returns text as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS');
$$ language sql;

create table if not exists families (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default now_text()
);

create table if not exists members (
  id integer generated always as identity primary key,
  name text not null,
  barcode text not null unique,
  member_code text,
  active integer not null default 1,
  notes text,
  member_type text not null default 'student' check (member_type in ('student','parent','admin')),
  address text,
  city text,
  state text,
  zip text,
  phone text,
  email text,
  photo_path text,
  birthday text,
  grade_level text,
  medical_notes text,
  family_id integer references families(id) on delete set null,
  is_primary_parent integer not null default 0,
  -- Vestigial portal-login columns - see db/schema.sql's own comment on
  -- why these are kept rather than dropped. Carried over unchanged.
  username text unique,
  password_hash text,
  portal_parent integer not null default 0,
  portal_student integer not null default 0,
  portal_coop_admin integer not null default 0,
  created_at text not null default now_text()
);

create table if not exists categories (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default now_text()
);

create table if not exists rosters (
  id integer generated always as identity primary key,
  name text not null,
  category text,
  active integer not null default 1,
  created_at text not null default now_text(),
  schedule_day text
);

create table if not exists roster_dates (
  roster_id integer not null references rosters(id) on delete cascade,
  session_date text not null,
  primary key (roster_id, session_date)
);

create table if not exists roster_members (
  roster_id integer not null references rosters(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  scheduled_arrival text,
  scheduled_departure text,
  source text not null default 'auto' check (source in ('auto','manual')),
  primary key (roster_id, member_id)
);

create table if not exists attendance (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  roster_id integer not null references rosters(id) on delete cascade,
  session_date text not null,
  status text not null check (status in ('present','late','absent')),
  check_in_time bigint, -- epoch ms
  source text not null default 'kiosk',
  reason_category text check (reason_category in ('personal','medical') or reason_category is null),
  reason_text text,
  recorded_at text not null default now_text(),
  unique (member_id, roster_id, session_date)
);

create table if not exists checkouts (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  roster_id integer not null references rosters(id) on delete cascade,
  session_date text not null,
  -- Legacy pickup/car-line number (1-80), chosen at the old checkout
  -- kiosk's number-grid step. That step no longer exists for either
  -- member type (see task_item_id below) - kept only so historical rows
  -- and their existing displays (admin-logs.js, admin-rosters.js,
  -- routes/admin-members.js) keep working untouched; every new checkout
  -- leaves this null.
  number integer check (number is null or number between 1 and 80),
  -- The Setup/Cleanup task a parent scanned at checkout (routes/checkout.js's
  -- /checkout/task-scan step), replacing the old pickup-number choice. Null
  -- for students (who no longer scan a task at all - see routes/checkout.js)
  -- and for any parent checkout predating this feature. No inline REFERENCES
  -- here - task_list_items is created further down this file, so the FK
  -- itself is added as an ALTER TABLE right after that table exists (see
  -- below); ON DELETE SET NULL there (not CASCADE) so deleting a task from
  -- the Task List doesn't erase the historical fact that this member
  -- checked out that day, only which task they scanned.
  task_item_id integer,
  check_out_time bigint not null, -- epoch ms
  recorded_at text not null default now_text(),
  unique (member_id, roster_id, session_date)
);

create table if not exists admins (
  id integer generated always as identity primary key,
  username text not null unique,
  password_hash text not null,
  created_at text not null default now_text()
);

create table if not exists volunteer_lists (
  id integer generated always as identity primary key,
  day text not null unique check (day in ('monday','wednesday')),
  roster_id integer references rosters(id) on delete set null
);

create table if not exists volunteer_sections (
  id integer generated always as identity primary key,
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  position integer not null,
  label text not null,
  unique (volunteer_list_id, position)
);

create table if not exists volunteer_dates (
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  session_date text not null,
  primary key (volunteer_list_id, session_date)
);

create table if not exists volunteer_members (
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  section_id integer not null references volunteer_sections(id) on delete cascade,
  rank text not null default 'sometimes',
  primary key (volunteer_list_id, member_id, section_id)
);

create table if not exists volunteer_assignments (
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  session_date text not null,
  position text,
  room text,
  primary key (volunteer_list_id, member_id, session_date)
);

create table if not exists setup_teams (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  title text not null,
  description text,
  leader_id integer references members(id) on delete set null,
  created_at text not null default now_text()
);

create table if not exists setup_team_members (
  team_id integer not null references setup_teams(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  primary key (team_id, member_id)
);

create table if not exists task_list_sections (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  title text not null,
  team_id integer references setup_teams(id) on delete set null,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_task_list_sections_day on task_list_sections(day);

create table if not exists task_list_items (
  id integer generated always as identity primary key,
  section_id integer not null references task_list_sections(id) on delete cascade,
  description text not null,
  position integer not null default 0,
  -- Permanent 6-digit code assigned once at creation (utils/taskList.js's
  -- generateTaskCode, mirroring utils/members.js's generateMemberCode) -
  -- unlike itemsForSection's own display "Number" (a derived row
  -- position that shifts whenever an earlier item is deleted/reordered),
  -- this is this ONE task's own stable identity, printed as a scannable
  -- barcode on its own Setup/Cleanup badge (see misc_badges.task_item_id
  -- below) so a parent can scan it at checkout to confirm which task
  -- they completed.
  barcode text unique
);
create index if not exists idx_task_list_items_section on task_list_items(section_id);

-- checkouts.task_item_id's FK, added here (not inline on checkouts' own
-- create table above) since task_list_items has to exist first. Wrapped
-- in an existence check (Postgres has no "ADD CONSTRAINT IF NOT EXISTS")
-- since this whole file re-runs against an already-schema'd PGlite
-- database on every local boot (see db/index.js) - without it, the
-- second run onward would fail with a duplicate-constraint error.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checkouts_task_item_id_fkey') then
    alter table checkouts
      add constraint checkouts_task_item_id_fkey
      foreign key (task_item_id) references task_list_items(id) on delete set null;
  end if;
end $$;

create table if not exists name_tag_requests (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  request_type text not null check (request_type in ('lost_tag','schedule_change')),
  day text not null check (day in ('monday','wednesday','both')),
  description text,
  archived integer not null default 0,
  created_at text not null default now_text()
);

create table if not exists name_tag_templates (
  member_type text primary key check (member_type in ('student','parent','admin')),
  layout_json text not null default '[]',
  updated_at text not null default now_text()
);

create table if not exists misc_badge_templates (
  badge_type text primary key check (badge_type in ('setupCleanup','custom')),
  layout_json text not null default '[]',
  updated_at text not null default now_text()
);

create table if not exists misc_badges (
  id integer generated always as identity primary key,
  badge_type text not null check (badge_type in ('setupCleanup','custom')),
  badge_number text,
  title text,
  description text,
  created_at text not null default now_text(),
  -- Set only for badge_type = 'setupCleanup' rows - the same value as
  -- that task's own task_list_items.barcode, kept here too so this
  -- table's own existing render path (miscBadgeRowData) doesn't need a
  -- join back to task_list_items just to print the barcode.
  barcode text,
  -- Links a 'setupCleanup' badge back to the Task List item it was
  -- auto-created from (see utils/taskList.js's addItem/updateItem/
  -- deleteItem) - Setup/Cleanup badges are no longer a separately
  -- admin-imported deck (unlike 'custom', which still is); each one now
  -- exists because a task exists, and ON DELETE CASCADE keeps them in
  -- lockstep without needing separate delete-sync code. Always null for
  -- 'custom' rows.
  task_item_id integer references task_list_items(id) on delete cascade
);

create table if not exists member_schedules (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  day text not null check (day in ('monday','wednesday')),
  class_number integer not null check (class_number between 1 and 4),
  time text,
  class_name text,
  room text,
  teacher text,
  updated_at text not null default now_text(),
  unique (member_id, day, class_number)
);

create table if not exists schedule_card_templates (
  id integer primary key check (id = 1),
  layout_json text not null default '[]',
  updated_at text not null default now_text()
);

create table if not exists class_schedule_hours (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  position integer not null check (position between 1 and 4),
  label text not null default '',
  -- The hour's own shared Start/End Time, set once via the Class Schedule
  -- page's Edit Hours dialog - every class in this position that day uses
  -- it unless that class sets its own start_time/end_time (see classes
  -- table above), which overrides it. Nullable/free text like classes'
  -- own start_time/end_time (utils/classSchedule.js's
  -- parseClockMinutesLocal is what actually validates the format at read
  -- time, not a DB constraint).
  start_time text,
  end_time text,
  unique (day, position)
);

create table if not exists classes (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  hour_position integer not null check (hour_position between 1 and 4),
  class_name text not null,
  room text,
  age_group text,
  color text not null default '#EE9A4D',
  notes text,
  start_time text,
  end_time text,
  created_at text not null default now_text(),
  roster_id integer references rosters(id) on delete set null
);

create table if not exists class_enrollments (
  class_id integer not null references classes(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  primary key (class_id, student_id)
);

create table if not exists class_staff (
  class_id integer not null references classes(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  role text not null default 'teacher' check (role in ('teacher','assistant')),
  primary key (class_id, member_id)
);

-- One row per archived class - the Class Schedule's own equivalent of
-- roster_archives above, same "flatten to plain text, drop the FK-linked
-- detail" philosophy (see that table's own header comment on why): a
-- class_staff/class_enrollments row has no business surviving its class
-- being deleted, so teacher/assistant names are captured as a flat
-- comma-joined string and enrollment as a plain count rather than kept
-- as live references. Populated by archiveClasses (utils/classSchedule.js),
-- which snapshots then deletes the live class in one step - "archiving"
-- a class removes it from the live schedule the same as deleting it,
-- just with this recoverable record left behind first.
create table if not exists class_schedule_archives (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  class_name text not null,
  room text,
  age_group text,
  color text,
  notes text,
  start_time text,
  end_time text,
  teachers text,
  assistants text,
  student_count integer not null default 0,
  archived_at text not null default now_text()
);
create index if not exists idx_class_schedule_archives_day on class_schedule_archives(day, archived_at);

-- One row per archived member schedule - the Student/Parent Schedules
-- tab's own equivalent of class_schedule_archives above. Archiving a
-- member's schedule card unenrolls them from every class they're
-- currently enrolled in (student) or staffing (parent) - same "flatten to
-- plain text, drop the FK-linked detail" reasoning as that table, since a
-- class_enrollments/class_staff row has no business surviving the
-- unenroll. member_id is kept (unlike class_schedule_archives, which has
-- no equivalent live row to point back to) so the archive can still be
-- traced to the member if they're re-enrolled later, but ON DELETE SET
-- NULL rather than CASCADE - member_name/member_type are captured too so
-- the archive record itself stays meaningful even if the member is later
-- deleted outright. Populated by archiveMemberSchedules
-- (utils/schedule.js).
create table if not exists member_schedule_archives (
  id integer generated always as identity primary key,
  member_id integer references members(id) on delete set null,
  member_name text not null,
  member_type text not null check (member_type in ('student','parent')),
  monday_schedule text,
  wednesday_schedule text,
  archived_at text not null default now_text()
);
create index if not exists idx_member_schedule_archives_type on member_schedule_archives(member_type, archived_at);

create table if not exists app_settings (
  key text primary key,
  value text not null
);

create table if not exists leadership_contacts (
  id integer generated always as identity primary key,
  role text not null,
  name text,
  email text,
  position integer not null default 0
);

create table if not exists contact_admin_messages (
  id integer generated always as identity primary key,
  leadership_team text not null,
  sender_email text not null,
  title text not null,
  message text not null,
  archived integer not null default 0,
  created_at text not null default now_text()
);

create table if not exists membership_requests (
  id integer generated always as identity primary key,
  parent1_first_name text not null,
  parent1_last_name text not null,
  parent1_email text not null,
  parent1_phone text,
  parent2_first_name text,
  parent2_last_name text,
  parent2_email text,
  parent2_phone text,
  address text,
  city text,
  state text,
  zipcode text,
  volunteer_interests text,
  archived integer not null default 0,
  created_at text not null default now_text()
);

create table if not exists membership_request_children (
  id integer generated always as identity primary key,
  request_id integer not null references membership_requests(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  birthdate text,
  grade_level text,
  medical_notes text,
  photo_path text
);

create table if not exists documents (
  id integer generated always as identity primary key,
  title text not null,
  file_path text not null,
  original_name text not null,
  mime_type text,
  uploaded_at text not null default now_text()
);

create table if not exists permanent_jobs (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  hour_position integer not null check (hour_position between 1 and 4),
  title text not null,
  room text,
  created_at text not null default now_text()
);

create table if not exists permanent_job_floaters (
  job_id integer not null references permanent_jobs(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  primary key (job_id, member_id)
);

create table if not exists substitute_assignments (
  id integer generated always as identity primary key,
  session_date text not null,
  slot_type text not null check (slot_type in ('class','job')),
  slot_id integer not null,
  member_id integer not null references members(id) on delete cascade,
  is_override integer not null default 0,
  status text not null default 'approved',
  created_at text not null default now_text(),
  unique (session_date, slot_type, slot_id)
);

create table if not exists library_items (
  id integer generated always as identity primary key,
  title text not null,
  barcode text not null unique,
  type text,
  created_at text not null default now_text()
);

create table if not exists library_item_types (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default now_text()
);

create table if not exists library_checkouts (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  item_id integer not null references library_items(id) on delete cascade,
  checked_out_at text not null default now_text(),
  checked_in_at text,
  due_date text
);
create index if not exists idx_library_checkouts_member on library_checkouts(member_id);
create index if not exists idx_library_checkouts_item on library_checkouts(item_id);

create table if not exists roster_archives (
  id integer generated always as identity primary key,
  day text not null check (day in ('monday','wednesday')),
  archived_at text not null default now_text(),
  data_json text not null
);
create index if not exists idx_roster_archives_day on roster_archives(day, archived_at);

create index if not exists idx_attendance_session on attendance(roster_id, session_date);
create index if not exists idx_checkouts_session on checkouts(roster_id, session_date);
create index if not exists idx_members_barcode on members(barcode);
create unique index if not exists idx_members_member_code on members(member_code) where member_code is not null;
create index if not exists idx_roster_members_member on roster_members(member_id);
create index if not exists idx_roster_dates_date on roster_dates(session_date);
create index if not exists idx_volunteer_members_section on volunteer_members(section_id);
create index if not exists idx_volunteer_dates_date on volunteer_dates(session_date);
create index if not exists idx_setup_teams_day on setup_teams(day);

-- Backs the app's admin session store (replaces utils/sqliteSessionStore.js
-- with a Postgres-backed equivalent - see utils/pgSessionStore.js).
-- expires_at is bigint, not integer - see the file header note on why.
create table if not exists sessions (
  sid text primary key,
  data_json text not null,
  expires_at bigint not null
);
create index if not exists idx_sessions_expires on sessions(expires_at);

-- Row Level Security: every table gets RLS turned on with no policies at
-- all, which makes every table default-deny for both the `anon` and
-- `authenticated` API roles - the browser never talks to Supabase
-- directly in this app (see MIGRATION.md), so nothing needs read/write
-- access through those roles today. The server's own Postgres connection
-- uses a role that bypasses RLS entirely (Supabase's `service_role`, or a
-- superuser-equivalent role for a non-Supabase Postgres), so none of this
-- affects the app's own behavior - it's a second layer of protection so a
-- leaked anon/authenticated credential, or a future direct-from-browser
-- feature added without thinking this through, can't read or write
-- anything by default until a real policy is written for it.
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ===== 20260817012545_setup_cleanup_assignments.sql =====
-- Setup/Cleanup Assignments tab: unlike the standing setup_teams roster
-- (no dates, no per-session state), this tab is date-scoped like Floater
-- Assignments - an admin picks a session date and suggests which task
-- (from that team's linked task_list_sections/task_list_items, see
-- task_list_sections.team_id) each team member should do that day.
-- Mirrors volunteer_dates/volunteer_assignments' shape, just keyed by
-- `day` directly instead of a volunteer_list_id - setup_teams has no
-- single "list" a date belongs to the way a Floater day does.
create table if not exists setup_dates (
  day text not null check (day in ('monday','wednesday')),
  session_date text not null,
  primary key (day, session_date)
);

-- One suggested task per member per date - a member can only actually do
-- one cleanup task at a time. task_item_id is nullable (ON DELETE SET
-- NULL, not CASCADE) so deleting a task list item clears the suggestion
-- instead of silently deleting the whole assignment row and losing the
-- fact that this member had *something* assigned that day.
create table if not exists setup_task_assignments (
  day text not null check (day in ('monday','wednesday')),
  member_id integer not null references members(id) on delete cascade,
  session_date text not null,
  task_item_id integer references task_list_items(id) on delete set null,
  primary key (day, member_id, session_date)
);
create index if not exists idx_setup_task_assignments_date on setup_task_assignments(day, session_date);

-- Same default-deny RLS posture as every other table (see the initial
-- schema migration's own comment) - these two are new since that
-- migration ran, so its one-time loop over existing tables never touched
-- them; each new migration adding a table has to enable RLS on it itself.
alter table public.setup_dates enable row level security;
alter table public.setup_task_assignments enable row level security;

-- ===== 20260817020000_setup_second_task_slot.sql =====
-- Real bug report: Setup/Cleanup Assignments only ever offered a single
-- "Suggested Task" dropdown per member per date, but a small team
-- routinely needs one member covering two jobs (e.g. Chairs AND Trash) -
-- see setup_task_assignments' own original comment claiming "a member can
-- only actually do one cleanup task at a time", which isn't actually true
-- in practice. A second, independent slot rather than a join table/array
-- column - the Assignments page always shows exactly two dropdowns per
-- member (see partials/setup-assignment-cards.ejs), never a variable
-- "add another" list, so a second nullable column mirrors that fixed
-- shape directly instead of modeling a list nothing needs.
alter table setup_task_assignments add column if not exists task_item_id_2 integer references task_list_items(id) on delete set null;

-- ===== 20260818000000_volunteer_floater_exclusions.sql =====
-- Real bug report: "when deleting members off the floater lists the
-- member isn't removed." Root cause: routes/admin-volunteers.js's
-- remove-member route deletes the volunteer_members row, then calls
-- syncDayMemberRosters(day) to keep the day's Parent/Student rosters in
-- sync - but that same sync unconditionally re-runs
-- autoAssignFloatersForDay(day) first (utils/classSchedule.js), which
-- re-derives "should this family's primary parent float this hour" from
-- scratch (their family's drop-off/pickup window overlaps the hour, and
-- they have no class of their own that hour) and re-inserts them right
-- back in - on the SAME request as the removal. volunteer_members has no
-- way to tell "never added" from "explicitly removed" (unlike
-- roster_members' own source column - see setRosterMembership). This
-- table records exactly that: an explicit removal that must survive the
-- very next auto-assign sync. autoAssignFloatersForDay now skips any
-- (member, section) pair listed here; an explicit re-add (+Add Member/
-- import - see addMemberToSection) clears the matching row, since a
-- deliberate add always wins over a past removal.
create table if not exists volunteer_floater_exclusions (
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  section_id integer not null references volunteer_sections(id) on delete cascade,
  primary key (volunteer_list_id, member_id, section_id)
);

-- ===== 20260818010000_admin_positions.sql =====
-- Real request: an "admin name tag" (logo, name, barcode, ID number, admin
-- position) for co-op staff/leaders, plus a Settings-managed list of
-- position titles (e.g. "President", "Treasurer") that a member of type
-- 'admin' can optionally be assigned on the member form. members.member_type
-- and name_tag_templates.member_type's own CHECK constraints already allow
-- 'admin' (see the initial schema migration's own comment on both) - this
-- was reserved for exactly this feature, so neither needs widening here.
--
-- admin_positions is a flat ordered list, the same "Settings page manages a
-- list, other forms pick from it" shape as leadership_contacts/
-- task_list_items - just simpler (no sections, no per-row extra fields).
create table if not exists admin_positions (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

-- Optional - a member of any type could hold a listed position (typically
-- 'admin', but nothing here forces that), same nullable-FK "not chosen yet"
-- shape as members.family_id above. ON DELETE SET NULL so deleting a
-- position off the Settings list doesn't cascade-delete the members who
-- held it - it just clears their selection back to "none".
alter table members add column if not exists admin_position_id integer references admin_positions(id) on delete set null;

-- ===== 20260818020000_setup_cleanup_badge_fields.sql =====
-- Real bug report: "Setup/cleanup task cards are a mess... The only
-- information that should be included on each setup/cleanup badge is
-- day, team name, leader, task and the barcode." The badge previously
-- showed a big scannable badge_number plus title=task text/
-- description=task-list-section title, with no shrink-to-fit sizing -
-- overlapping text on anything longer than a short task. Redesigning the
-- badge to the requested 5 fields repurposes misc_badges' existing
-- title/description columns for setupCleanup rows (title -> team name,
-- description -> task text, swapped from their old meaning) and adds the
-- two genuinely new fields, day and leader_name - both nullable, and
-- both always null for 'custom' rows (that badge type keeps its own
-- generic title/description shape, untouched by this).
alter table misc_badges add column if not exists day text;
alter table misc_badges add column if not exists leader_name text;

-- ===== 20260819000000_member_admin_positions.sql =====
-- Real request: "ability to add unlimited admin positions to a member
-- profile" - members.admin_position_id (20260818010000_admin_positions.sql)
-- was a single nullable FK, one position per member. This adds a proper
-- many-to-many join table (same shape as setup_team_members) so a member
-- can hold any number of listed positions at once - a co-op leader who's
-- both "Secretary" and "Fundraising Coordinator", say.
create table if not exists member_admin_positions (
  member_id integer not null references members(id) on delete cascade,
  admin_position_id integer not null references admin_positions(id) on delete cascade,
  primary key (member_id, admin_position_id)
);

-- One-time carry-over of whatever single position a member already had
-- selected before this table existed, so nobody's existing assignment
-- silently disappears the moment this ships. ON CONFLICT DO NOTHING makes
-- this safe to re-run (this file re-runs against an already-schema'd
-- PGlite database on every local boot - see db/index.js) without ever
-- re-inserting rows an admin has since deliberately removed via the new
-- multi-select form.
insert into member_admin_positions (member_id, admin_position_id)
select id, admin_position_id from members where admin_position_id is not null
on conflict (member_id, admin_position_id) do nothing;

-- members.admin_position_id itself is deliberately left in place (not
-- dropped) rather than migrated further - nothing reads it anymore as of
-- this change (routes/admin-members.js and utils/nameTagData.js both move
-- to member_admin_positions below), but dropping a column outright is a
-- separate, harder-to-undo decision this request didn't ask for.
alter table public.member_admin_positions enable row level security;

-- ===== 20260819010000_setup_team_meeting_details.sql =====
-- Real request: "setup/cleanup team cards should have a space for time to
-- meet and meeting location. the leader, time, location, all those
-- details should show on the kiosk side when you click the setup/cleanup
-- button." Both nullable free text (matching setup_teams.description's own
-- shape) - a team without a fixed time/place yet just shows nothing extra,
-- same as a team with no leader or description today.
alter table setup_teams add column if not exists meeting_time text;
alter table setup_teams add column if not exists meeting_location text;

-- ===== 20260821000000_training_module.sql =====
-- Training & Learning module - see utils/training.js for the module's own
-- full design writeup (why lesson progress is keyed to the ATTEMPT, not
-- the assignment; why quiz answers/lesson progress snapshot their own
-- text instead of just joining live; how server-side grading works).
--
-- Follows this schema file's own established conventions throughout
-- (see initial_schema.sql's own header note): `integer generated always
-- as identity primary key`, `text not null default now_text()` for
-- timestamps, plain `integer` 0/1 for flags, `check (... in (...))` for
-- enums.

create table if not exists trainings (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  estimated_minutes integer,
  passing_score integer not null default 80 check (passing_score between 0 and 100),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- Completion Requirements (Training Builder's own configurable section -
  -- see item 12 of the module's design). require_video_completion and
  -- video_completion_threshold together are "watch all required videos";
  -- there's no separate "complete all lessons" flag - that's just what
  -- finishing every required lesson in the outline already means.
  sequential_lessons integer not null default 1,
  require_video_completion integer not null default 1,
  video_completion_threshold integer not null default 95 check (video_completion_threshold between 1 and 100),
  require_retake_after_failure integer not null default 1,
  allow_skipping_lessons integer not null default 0,
  require_manager_approval integer not null default 0,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists training_lessons (
  id integer generated always as identity primary key,
  training_id integer not null references trainings(id) on delete cascade,
  title text not null,
  description text,
  -- Deliberately just a plain text column, not its own lookup table - a
  -- new lesson type is a new value here plus a new branch wherever
  -- utils/training.js switches on it (grading, locking, rendering), not
  -- a schema change. video_url/content below are simply unused for
  -- whichever type doesn't need them.
  type text not null check (type in ('video', 'text', 'quiz')),
  position integer not null default 0,
  required integer not null default 1,
  -- Video lessons: a direct link to an externally-hosted video file,
  -- played through a plain <video> element - see utils/training.js's own
  -- header comment for why this app doesn't host/stream video files
  -- itself.
  video_url text,
  -- Text lessons: the lesson's own instructional content. Also doubles
  -- as an optional supplementary reading block on a video lesson (module
  -- design item 1's own example: "Company Policies - Video + reading").
  content text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_training_lessons_training on training_lessons(training_id);

-- Optional image resources attached to a lesson (module design item
-- "Add images/resources where supported by the existing application") -
-- reuses the exact same imageFileFilter/Storage upload pattern member
-- photos and design images already use (see utils/uploads.js,
-- utils/storage.js), just a new table for what it's attached to.
create table if not exists training_lesson_resources (
  id integer generated always as identity primary key,
  lesson_id integer not null references training_lessons(id) on delete cascade,
  file_path text not null,
  original_name text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_training_lesson_resources_lesson on training_lesson_resources(lesson_id);

-- One row per answer option on a multiple_choice question - "type" lives
-- on the question (below), not here, so a future question type (true/
-- false, multiple-answer) reuses this same options table rather than
-- needing its own.
create table if not exists training_quiz_questions (
  id integer generated always as identity primary key,
  lesson_id integer not null references training_lessons(id) on delete cascade,
  question text not null,
  type text not null default 'multiple_choice' check (type in ('multiple_choice')),
  points integer not null default 1 check (points > 0),
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_training_quiz_questions_lesson on training_quiz_questions(lesson_id);

create table if not exists training_quiz_options (
  id integer generated always as identity primary key,
  question_id integer not null references training_quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_training_quiz_options_question on training_quiz_options(question_id);

-- One row per (training, member) - the individual's own state,
-- deliberately separate from the training definition itself (a member
-- may take the same training multiple times - see training_attempts -
-- and multiple members share the same training rows).
create table if not exists training_assignments (
  id integer generated always as identity primary key,
  training_id integer not null references trainings(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'passed', 'failed', 'retry_required', 'expired')),
  current_lesson_id integer references training_lessons(id) on delete set null,
  assigned_at text not null default now_text(),
  due_at text,
  completed_at text,
  best_score integer,
  latest_score integer,
  attempt_count integer not null default 0,
  unique (training_id, member_id)
);
create index if not exists idx_training_assignments_member on training_assignments(member_id);
create index if not exists idx_training_assignments_training on training_assignments(training_id);

-- One row per attempt at an assignment - never overwritten, so a
-- member's full attempt history (module design item 15) survives every
-- retake. training_title_snapshot/passing_score_snapshot freeze the
-- rule this specific attempt was actually graded under, so an admin
-- editing the training's passing score later can't silently reclassify
-- an already-decided historical attempt (module design item 19).
create table if not exists training_attempts (
  id integer generated always as identity primary key,
  assignment_id integer not null references training_assignments(id) on delete cascade,
  attempt_number integer not null,
  started_at text not null default now_text(),
  completed_at text,
  score integer,
  passed integer,
  passing_score_snapshot integer not null,
  training_title_snapshot text not null,
  created_at text not null default now_text(),
  unique (assignment_id, attempt_number)
);
create index if not exists idx_training_attempts_assignment on training_attempts(assignment_id);

-- Lesson-level state, one row per (attempt, lesson) - keyed to the
-- ATTEMPT rather than the assignment is the whole reason a retake
-- ("Repeat Entire Training") just works: starting attempt 2 means fresh
-- locked/available rows for every lesson, while attempt 1's own progress
-- (including its video-watch history) stays exactly as it was for
-- reporting. lesson_id is ON DELETE SET NULL, not CASCADE - deleting a
-- lesson later must never erase a past attempt's own history of it, so
-- *_snapshot columns carry what the member actually saw regardless of
-- what happens to the live lesson afterward.
create table if not exists training_lesson_progress (
  id integer generated always as identity primary key,
  attempt_id integer not null references training_attempts(id) on delete cascade,
  lesson_id integer references training_lessons(id) on delete set null,
  lesson_title_snapshot text not null,
  lesson_type_snapshot text not null,
  lesson_position_snapshot integer not null,
  lesson_required_snapshot integer not null,
  status text not null default 'locked' check (status in ('locked', 'available', 'in_progress', 'completed')),
  video_started integer not null default 0,
  -- The furthest point (seconds) actually reached via real playback
  -- <timeupdate> events - not just the latest currentTime, so a scrub-to-
  -- the-end doesn't count as having watched the middle. video_percent is
  -- derived from this against video_duration_seconds once known.
  video_max_watched_seconds real not null default 0,
  video_duration_seconds real,
  video_percent integer not null default 0,
  video_completed integer not null default 0,
  video_completed_at text,
  started_at text,
  completed_at text,
  unique (attempt_id, lesson_id)
);
create index if not exists idx_training_lesson_progress_attempt on training_lesson_progress(attempt_id);

-- One row per (attempt, question) - answers belong to the attempt they
-- were submitted under, same historical-fidelity reasoning as lesson
-- progress above. question_id/selected_option_id are ON DELETE SET
-- NULL, never CASCADE, for the same reason: editing/deleting a question
-- after the fact must not corrupt or erase what a member already
-- answered - the *_snapshot columns are the actual record of what was
-- graded.
create table if not exists training_quiz_answers (
  id integer generated always as identity primary key,
  attempt_id integer not null references training_attempts(id) on delete cascade,
  question_id integer references training_quiz_questions(id) on delete set null,
  question_text_snapshot text not null,
  points_possible_snapshot integer not null,
  selected_option_id integer references training_quiz_options(id) on delete set null,
  selected_option_text_snapshot text,
  is_correct integer not null default 0,
  points_earned integer not null default 0,
  created_at text not null default now_text(),
  unique (attempt_id, question_id)
);
create index if not exists idx_training_quiz_answers_attempt on training_quiz_answers(attempt_id);

-- ===== 20260823161125_playground_checkin.sql =====
-- Real request: "we need to add a playground check in and out and log.
-- anybody can check in and out of the playground. it doesn't have a set
-- roster." Reuses the existing rosters/attendance/checkouts tables rather
-- than inventing a parallel log - one roster per (day, hour_position),
-- lazily created the same way a class's own roster is (see
-- ensureClassRoster in utils/classSchedule.js) - so every existing
-- attendance/checkouts index and constraint already covers this. The one
-- real difference from every other roster on this site: "who's on it" is
-- never a fixed roster_members list - it's simply whoever has an
-- attendance/checkouts row for that roster+date, since anybody can walk up
-- and check in with no enrollment step at all (see
-- utils/playground.js's playgroundLogForDate).
create table if not exists playground_rosters (
  day text not null check (day in ('monday','wednesday')),
  hour_position integer not null check (hour_position between 1 and 4),
  roster_id integer not null references rosters(id) on delete cascade,
  primary key (day, hour_position)
);

-- ===== 20260824180000_setup_team_task_scan_timing.sql =====
-- Real request: "add a dropdown menu to each setup/cleanup team list that
-- asks, log on check in or log on check out. choosing one or the other
-- will determine when a member is asked to scan their setup/cleanup
-- card." Every parent/admin was always asked to scan their Setup/Cleanup
-- badge at CHECK OUT (routes/checkout.js) with no team-level choice at
-- all - this lets a team opt into asking at CHECK IN instead (routes/
-- kiosk.js). Defaults to 'checkout' so every existing team keeps today's
-- behavior with no admin action required.
alter table setup_teams add column if not exists task_scan_timing text not null default 'checkout'
  check (task_scan_timing in ('checkin', 'checkout'));

-- ===== 20260824180500_attendance_task_scan.sql =====
-- Real request: "add a dropdown menu to each setup/cleanup team list
-- that asks, log on check in or log on check out ... if team 1 is, log
-- on check in, those members will click check in, scan their name tag,
-- then will be asked to scan their setup/cleanup card." Before this, a
-- parent/admin was always asked to scan their Setup/Cleanup badge at
-- CHECK OUT (checkouts.task_item_id, routes/checkout.js), with no way to
-- ask at check-in instead. attendance needs its own task_item_id to
-- carry that scan from check-in through to the eventual checkout event
-- (routes/kiosk.js writes it; routes/checkout.js copies it into the
-- checkouts row it creates, so every existing report/export/print that
-- already reads checkouts.task_item_id keeps working unchanged).
-- task_scanned_at (epoch ms, like check_in_time) marks whether that
-- check-in-time step actually ran, distinct from task_item_id being
-- null for a legitimate reason (bypass badge, or genuinely unrecognized
-- scan - see findSetupCleanupBypassBadge's own comment) - checkout only
-- skips re-asking once this is actually set, never just because
-- task_item_id happens to be null.
alter table attendance add column if not exists task_item_id integer references task_list_items(id) on delete set null;
alter table attendance add column if not exists task_scanned_at bigint;

-- ===== 20260825020000_portal_platform_foundation.sql =====
-- Foundation for the new multi-portal platform (Public site, Parent,
-- Student, Teacher, Co-op Admin, and Main Admin portals) built on top of
-- the existing operational co-op app.
--
-- members already has a set of "Vestigial" portal-login columns
-- (username, password_hash, portal_parent, portal_student,
-- portal_coop_admin - see db/schema.sql's own comment) from an earlier
-- member-login feature that was removed sitewide. Those are left exactly
-- as documented (untouched, dead) rather than reused here: they only
-- support three fixed boolean flags with no real role/permission model
-- and no account-status/approval workflow, which the new platform
-- explicitly needs (a person can hold several roles, Main Admin controls
-- granular capabilities, self-registration needs an approval queue).
--
-- member_accounts is the new login layer, one-to-one with an existing
-- members row - a member's profile, family, photo, and medical data stay
-- exactly where they already live; this table only ever holds
-- credentials and account status. roles/permissions/role_permissions/
-- member_account_roles form a standard RBAC model: a role (e.g. "parent",
-- "teacher") grants both direct PORTAL access and, via role_permissions,
-- a set of finer-grained capability strings a route can check without
-- ever hard-coding "if role = X" - see middleware/portalAuth.js.

create table if not exists member_accounts (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  -- 'pending': self-registered, awaiting a Main Admin's review before any
  -- role/portal access is usable. 'active': can log in and use whatever
  -- roles they hold. 'suspended': login blocked without losing role
  -- history, for an admin temporarily revoking access.
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  created_at text not null default now_text(),
  approved_at text,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  last_login_at text
);
create index if not exists idx_member_accounts_status on member_accounts(status);

-- A role both grants access to a named portal (its own key doubles as the
-- portal identifier the new portal switcher/middleware checks) and,
-- through role_permissions, a bundle of finer-grained capabilities. Kept
-- as real rows (not a fixed enum) so a Main Admin can define additional
-- roles later without a schema change - is_system just protects the five
-- starter roles from being renamed/deleted out from under the portal
-- switcher's own routing.
create table if not exists roles (
  id integer generated always as identity primary key,
  key text not null unique,
  label text not null,
  description text,
  is_system integer not null default 0,
  created_at text not null default now_text()
);

-- A fixed catalog of capability strings a Main Admin can grant to any
-- role (see role_permissions) - deliberately a flat list rather than
-- hard-coding "if role === 'main_admin'" throughout the app, so a future
-- portal/feature only ever needs to add a new row here plus real
-- requirePortalPermission(key) checks at its own routes, never a change
-- to every existing route that already checks permissions.
create table if not exists permissions (
  id integer generated always as identity primary key,
  key text not null unique,
  label text not null,
  description text
);

create table if not exists role_permissions (
  role_id integer not null references roles(id) on delete cascade,
  permission_id integer not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- A member account can hold more than one role at once (e.g. Parent +
-- Teacher) - the portal switcher lists exactly the portals their current
-- roles grant, and every portal route re-checks this server-side
-- (middleware/portalAuth.js), never trusting a client-supplied portal
-- name.
create table if not exists member_account_roles (
  member_account_id integer not null references member_accounts(id) on delete cascade,
  role_id integer not null references roles(id) on delete cascade,
  granted_at text not null default now_text(),
  granted_by_account_id integer references member_accounts(id) on delete set null,
  primary key (member_account_id, role_id)
);

-- Site-wide public homepage text, one singleton row - the parts of the
-- new public website a Main Admin can edit without touching code
-- (org name/tagline, hero copy, meeting schedule, contact info). A full
-- drag-and-drop page builder is real future scope, not this pass; this
-- covers the actual copy that matters on day one.
create table if not exists site_settings (
  id integer primary key default 1 check (id = 1),
  org_name text not null default 'Sanford Homeschoolers',
  tagline text not null default 'A welcoming homeschool co-op for families who want more.',
  hero_heading text not null default 'A homeschool community built on connection',
  hero_body text not null default 'We meet weekly for classes, friendship, and support - come see what co-op life is all about.',
  meeting_schedule_text text not null default 'Mondays & Wednesdays, during the school year',
  about_body text not null default 'Sanford Homeschoolers is a parent-led homeschool co-op offering classes, activities, and community for homeschooling families of all backgrounds.',
  benefits_body text not null default 'Small classes taught by parents and volunteers, a supportive community, and a reliable weekly rhythm for your homeschool.',
  contact_email text,
  contact_phone text,
  updated_at text not null default now_text()
);
insert into site_settings (id) values (1) on conflict (id) do nothing;

-- Admin-authored announcements, shared across the public homepage (only
-- rows with is_public = 1) and every authenticated portal's own
-- dashboard (every active, non-expired announcement, public or not) -
-- one system instead of a separate "public news" and "member news"
-- table that would inevitably drift apart.
create table if not exists announcements (
  id integer generated always as identity primary key,
  title text not null,
  body text not null,
  is_public integer not null default 0,
  published_at text not null default now_text(),
  expires_at text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_announcements_published on announcements(published_at);

create table if not exists faqs (
  id integer generated always as identity primary key,
  question text not null,
  answer text not null,
  position integer not null default 0,
  is_public integer not null default 1,
  created_at text not null default now_text()
);

-- Registration-facing extensions to the EXISTING classes table, not a
-- parallel "course" model - a class is still exactly one row in
-- `classes`, this just adds what the Parent Portal's own registration
-- flow needs on top of the scheduling fields already there.
-- registration_open is a simple global per-class toggle for this pass -
-- staged, group-targeted registration windows (teachers first, then
-- certain families, then everyone) are real future scope, intentionally
-- not built here.
alter table classes add column if not exists capacity integer;
alter table classes add column if not exists registration_open integer not null default 0;
alter table classes add column if not exists description text;

-- One row per parent-initiated registration action, kept as its own
-- audit trail distinct from class_enrollments itself (which only ever
-- reflects CURRENT enrollment - a cancelled/waitlisted registration
-- still needs to be visible in "my registration history").
create table if not exists class_registrations (
  id integer generated always as identity primary key,
  class_id integer not null references classes(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  registered_by_account_id integer not null references member_accounts(id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed', 'waitlisted', 'cancelled')),
  created_at text not null default now_text(),
  cancelled_at text
);
create index if not exists idx_class_registrations_class on class_registrations(class_id);
create index if not exists idx_class_registrations_student on class_registrations(student_id);

-- ===== 20260825030000_events_module.sql =====
-- Community & Commerce track (Track B), item 1: Events. The backbone
-- other Track B features (volunteer/donation signups now, the Newsletter
-- and Notification Center later) hang off of - see TEAM_B_HANDOFF.md.
--
-- Registration reuses the "attendee is a members row, action is logged
-- against the signed-in member_account" shape Track A's own
-- class_registrations already established (routes/parent-portal.js) -
-- same reasoning: a parent portal account can register any of their own
-- family's members (including themselves) for an event, not just
-- themselves, and every action still has a real accountable actor.

create table if not exists events (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  category text,
  location text,
  -- Local-disk or Supabase Storage key (utils/storage.js's own
  -- convention - see routes/admin-documents.js), not a raw URL, so this
  -- follows the same storage-backend-agnostic pattern every other upload
  -- in this app already uses. Null is a perfectly normal event with no
  -- image.
  image_key text,
  starts_at text not null,
  ends_at text,
  -- 'public': shown on the public site to signed-out visitors too.
  -- 'members': only shown to a signed-in portal account (any role) - the
  -- "public/member visibility" toggle the handoff calls for.
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  capacity integer,
  -- 'draft' never appears anywhere outside admin event management.
  -- 'published' is live. 'cancelled' stays visible (with a cancelled
  -- badge) rather than being deleted, so existing registrations/
  -- volunteer signups/donation claims keep their history intact.
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_events_starts_at on events(starts_at);
create index if not exists idx_events_status_visibility on events(status, visibility);

create table if not exists event_registrations (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  registered_by_account_id integer references member_accounts(id) on delete set null,
  -- 'confirmed' or 'waitlisted' (capacity enforcement, same status shape
  -- as class_registrations), 'cancelled' keeps the row instead of
  -- deleting it - real registration history for admin reporting.
  status text not null default 'confirmed' check (status in ('confirmed', 'waitlisted', 'cancelled')),
  created_at text not null default now_text(),
  cancelled_at text,
  unique (event_id, member_id)
);
create index if not exists idx_event_registrations_event on event_registrations(event_id);
create index if not exists idx_event_registrations_member on event_registrations(member_id);

-- Per-event volunteer roles (handoff item 2) - "role name, number needed,
-- time, location, description". position orders them on the event page,
-- same ordering convention as e.g. setup_teams' own task lists.
create table if not exists event_volunteer_roles (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  role_name text not null,
  slots_needed integer not null default 1,
  time_label text,
  location text,
  description text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_volunteer_roles_event on event_volunteer_roles(event_id);

create table if not exists event_volunteer_signups (
  id integer generated always as identity primary key,
  volunteer_role_id integer not null references event_volunteer_roles(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (volunteer_role_id, member_id)
);
create index if not exists idx_event_volunteer_signups_role on event_volunteer_signups(volunteer_role_id);

-- Per-event donation/item requests (handoff item 3) - "item, quantity
-- needed/claimed, deadline". quantity_claimed is a real live SUM of
-- event_donation_claims.quantity_claimed, computed on read (utils/
-- events.js), never stored - the same "don't let a cached counter drift
-- from its own source of truth" principle the rest of this app already
-- follows for e.g. class enrollment counts.
create table if not exists event_donation_items (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  deadline text,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_donation_items_event on event_donation_items(event_id);

create table if not exists event_donation_claims (
  id integer generated always as identity primary key,
  donation_item_id integer not null references event_donation_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_event_donation_claims_item on event_donation_claims(donation_item_id);

-- ===== 20260825030000_registration_windows.sql =====
-- Staged, group-targeted class registration windows - the "teachers
-- first, then certain families, then everyone" scope the portal
-- foundation migration (20260825020000) called out as intentionally not
-- built there. A window targets an EXISTING role (reusing the roles
-- table rather than inventing a second "member group" concept) or
-- nobody in particular (role_key null = everyone). A class only accepts
-- registrations once BOTH its own registration_open flag is set AND, if
-- any windows exist at all, the registering parent qualifies for one
-- that's currently open - see routes/parent-portal.js's
-- windowIsOpenForAccount for the exact rule, including the "no windows
-- defined at all" back-compat case.
create table if not exists registration_windows (
  id integer generated always as identity primary key,
  label text not null,
  role_key text references roles(key) on delete cascade,
  opens_at text not null,
  closes_at text,
  created_at text not null default now_text()
);
create index if not exists idx_registration_windows_role on registration_windows(role_key);

-- ===== 20260825040000_academic_records.sql =====
-- Lessons/assignments/grading, diplomas, and transcripts - the last of
-- Track A's originally-scoped platform work (see PLATFORM_BUILD.md).
-- Reuses the EXISTING classes/class_enrollments/class_staff model
-- throughout; nothing here is a parallel course system.

-- A teacher's own assignment for one of their classes (class_staff
-- already governs who "owns" a class - see routes/teacher-portal.js).
-- class_name is a snapshot taken at creation, not a live join to
-- classes.class_name - the same "flatten to plain text, drop the
-- FK-linked detail" reasoning class_schedule_archives already documents,
-- needed here for the same reason: archiving a class deletes the live
-- `classes` row, and an assignment's grades are exactly the kind of
-- record a transcript needs to survive that. class_id itself is kept
-- (ON DELETE SET NULL, not CASCADE) only as a live-class convenience
-- lookup for the teacher's own gradebook; nothing reads it once the
-- class is gone.
create table if not exists class_assignments (
  id integer generated always as identity primary key,
  class_id integer references classes(id) on delete set null,
  class_name text not null,
  title text not null,
  description text,
  due_date text,
  points_possible integer,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_class_assignments_class on class_assignments(class_id);

-- One row per student per assignment, upserted from the teacher's
-- gradebook screen. points_earned/feedback both null until graded - an
-- assignment existing doesn't imply every enrolled student has a row.
create table if not exists assignment_grades (
  id integer generated always as identity primary key,
  assignment_id integer not null references class_assignments(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  points_earned numeric,
  feedback text,
  graded_at text,
  graded_by_account_id integer references member_accounts(id) on delete set null,
  unique (assignment_id, student_id)
);
create index if not exists idx_assignment_grades_student on assignment_grades(student_id);

-- Issued once per student by a Main Admin. Re-issuing just updates the
-- existing row (unique on student_id) rather than accumulating history -
-- a student only ever has the one, current diploma.
create table if not exists diplomas (
  id integer generated always as identity primary key,
  student_id integer not null unique references members(id) on delete cascade,
  title text not null default 'Diploma of Completion',
  issued_date text not null,
  body_text text,
  issued_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);

-- A per-student snapshot of a class taken to completion, written once by
-- archiveClasses (utils/classSchedule.js) at the moment a class is
-- archived - the ONLY source of past-term transcript data, since
-- archiving already deletes the live class (and cascades away its
-- class_enrollments rows) as part of the same operation. Terms archived
-- before this migration existed have no reconstructable history, the
-- same limitation class_schedule_archives itself already has for
-- pre-existing archived classes.
create table if not exists student_academic_history (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  class_name text not null,
  day text,
  age_group text,
  teacher_names text,
  term_ended_at text not null default now_text()
);
create index if not exists idx_student_academic_history_student on student_academic_history(student_id);

-- ===== 20260825040000_directory_classifieds.sql =====
-- Community & Commerce track (Track B), item 4: Business Directory and
-- Classifieds - built back to back per TEAM_B_HANDOFF.md since they share
-- the same shape: a member submits a listing, it starts 'pending' until a
-- Main Admin (manage_directory / manage_classifieds) approves it, then
-- it's visible per its own public/members visibility, same toggle Events
-- already established. An admin can also create/approve a listing
-- directly, so member_id can be any member (not just the submitter),
-- letting an admin list a business or item on someone else's behalf.

create table if not exists business_directory_listings (
  id integer generated always as identity primary key,
  member_id integer references members(id) on delete set null,
  business_name text not null,
  description text,
  category text,
  phone text,
  email text,
  website text,
  address text,
  image_key text,
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  -- 'pending': awaiting admin review, never shown outside admin
  -- management and the submitter's own "My Listings" view. 'active': live.
  -- 'archived': kept for history instead of deleted (matches events.status's
  -- own reasoning).
  status text not null default 'pending' check (status in ('pending', 'active', 'archived')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  approved_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_business_directory_status_visibility on business_directory_listings(status, visibility);
create index if not exists idx_business_directory_member on business_directory_listings(member_id);

create table if not exists classified_listings (
  id integer generated always as identity primary key,
  member_id integer references members(id) on delete set null,
  title text not null,
  description text,
  category text,
  -- Free text, not numeric - a real classifieds ad is as often "Free" or
  -- "Make an offer" as it is a fixed dollar amount, and this isn't an
  -- e-commerce checkout (that's the separate Store, item 8) where a real
  -- numeric price the code needs to total or charge would matter.
  price text,
  image_key text,
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  status text not null default 'pending' check (status in ('pending', 'active', 'sold', 'archived')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  approved_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_classifieds_status_visibility on classified_listings(status, visibility);
create index if not exists idx_classifieds_member on classified_listings(member_id);

-- ===== 20260825050000_member_directory.sql =====
-- Community & Commerce track (Track B), item 5: Member Directory. No new
-- copy of member data - this reads live from the existing `members`/
-- `families` tables (Track A's own domain, read-only here) rather than
-- duplicating it. Two small settings tables control what's actually
-- shown: which FIELDS a Main Admin has turned on directory-wide (never
-- expose a field just because it exists on `members` - a deliberate
-- allowlist a Main Admin opts fields INTO, not an every-field toggle),
-- and which INDIVIDUAL members have opted themselves (or a family
-- member) out entirely. Members-only, no public option - this is real
-- personal contact information, unlike Events/Directory/Classifieds'
-- own public/members visibility toggle.

create table if not exists member_directory_field_settings (
  -- One of a fixed catalog utils/memberDirectory.js defines
  -- (DIRECTORY_FIELDS) - deliberately not free text, so a Main Admin can
  -- only ever turn on a field this app was actually built to display
  -- safely, never an arbitrary members column.
  field_key text primary key check (field_key in ('photo', 'phone', 'email', 'address', 'grade_level', 'family')),
  visible integer not null default 0,
  updated_at text not null default now_text()
);

create table if not exists member_directory_opt_outs (
  member_id integer primary key references members(id) on delete cascade,
  opted_out_at text not null default now_text()
);

-- ===== 20260825060000_forums.sql =====
-- Community & Commerce track (Track B), item 6: Forums. Categories ->
-- threads -> posts, plus optional private class forums (scope='class',
-- class_id set) visible only to that class's own teacher/assistants
-- (class_staff), enrolled students (class_enrollments), and those
-- students' parents (read-only reference to Track A's classes/
-- class_enrollments/class_staff tables - never altered here, per the
-- hard boundary). A general category (scope='general') is visible to
-- any signed-in portal account, any role - members-only overall, no
-- public browsing, same reasoning as Member Directory.

create table if not exists forum_categories (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  scope text not null default 'general' check (scope in ('general', 'class')),
  class_id integer references classes(id) on delete cascade,
  position integer not null default 0,
  is_locked integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_forum_categories_class on forum_categories(class_id);

create table if not exists forum_threads (
  id integer generated always as identity primary key,
  category_id integer not null references forum_categories(id) on delete cascade,
  title text not null,
  member_id integer references members(id) on delete set null,
  account_id integer references member_accounts(id) on delete set null,
  is_pinned integer not null default 0,
  is_locked integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_forum_threads_category on forum_threads(category_id);

-- body_html is sanitized server-side (utils/sanitizeHtml.js) before ever
-- being stored - the rich-text toolbar (public/js/forum-editor.js) only
-- ever offers a handful of safe tags (headings/bold/italic/lists/links/
-- quotes) but the sanitizer is what actually enforces that, not client
-- trust.
create table if not exists forum_posts (
  id integer generated always as identity primary key,
  thread_id integer not null references forum_threads(id) on delete cascade,
  member_id integer references members(id) on delete set null,
  account_id integer references member_accounts(id) on delete set null,
  body_html text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at text not null default now_text(),
  updated_at text not null default now_text(),
  edited_at text
);
create index if not exists idx_forum_posts_thread on forum_posts(thread_id);

-- The audit trail Forums' own spec explicitly calls for. Track B's later
-- sitewide Audit Log (handoff item 13) can read from tables like this one
-- once it exists, rather than this being retrofitted after the fact.
create table if not exists forum_moderation_actions (
  id integer generated always as identity primary key,
  actor_account_id integer references member_accounts(id) on delete set null,
  action text not null check (action in ('edit', 'remove', 'restore', 'lock', 'unlock', 'pin', 'unpin', 'archive', 'unarchive', 'move')),
  target_type text not null check (target_type in ('thread', 'post')),
  target_id integer not null,
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_forum_moderation_actions_target on forum_moderation_actions(target_type, target_id);

-- ===== 20260825070000_custom_forms.sql =====
-- Community & Commerce track (Track B), item 7: Custom Forms - one
-- generic, reusable form-builder system (per the handoff's own explicit
-- instruction: "do not create more one-off form tables after this").
-- Options for a choice-type field are their own child table
-- (custom_form_field_options), same pattern the existing Training
-- module already uses for quiz options (training_quiz_options) rather
-- than a JSON blob column - keeps this consistent with how the rest of
-- this app already models "a question/field with a list of options."

create table if not exists custom_forms (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists custom_form_fields (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  field_type text not null check (field_type in ('short_text', 'long_text', 'number', 'date', 'single_choice', 'multiple_choice', 'dropdown', 'checkbox', 'file')),
  label text not null,
  help_text text,
  is_required integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_custom_form_fields_form on custom_form_fields(form_id);

create table if not exists custom_form_field_options (
  id integer generated always as identity primary key,
  field_id integer not null references custom_form_fields(id) on delete cascade,
  label text not null,
  position integer not null default 0
);
create index if not exists idx_custom_form_field_options_field on custom_form_field_options(field_id);

-- "assign a form to specific people or groups" - a group is one of the
-- existing portal roles (parent/student/teacher/coop_admin/main_admin),
-- reusing the RBAC model rather than inventing a second grouping
-- concept. A form with ZERO assignment rows is open to any signed-in
-- portal account once published - a real, common case (a general
-- survey), not an error state.
create table if not exists custom_form_assignments (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  member_id integer references members(id) on delete cascade,
  role_id integer references roles(id) on delete cascade,
  created_at text not null default now_text(),
  check (member_id is not null or role_id is not null)
);
create index if not exists idx_custom_form_assignments_form on custom_form_assignments(form_id);

-- One submission per (form, member) - a permission slip or intake form
-- filled out on behalf of a specific member of the submitting account's
-- own family (self included), same "acting account, real member subject,
-- accountable actor" shape Events/Directory/Classifieds already use.
create table if not exists custom_form_submissions (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  submitted_at text not null default now_text(),
  unique (form_id, member_id)
);
create index if not exists idx_custom_form_submissions_form on custom_form_submissions(form_id);

-- value_text holds every field type's answer except multiple_choice
-- (checked boxes go in custom_form_answer_choices below, since a field
-- can have more than one selected option) - short_text/long_text/number/
-- date store their raw text, checkbox stores '1'/'0', single_choice/
-- dropdown store the selected option's label, file stores the uploaded
-- key (utils/storage.js's own convention).
create table if not exists custom_form_answers (
  id integer generated always as identity primary key,
  submission_id integer not null references custom_form_submissions(id) on delete cascade,
  field_id integer not null references custom_form_fields(id) on delete cascade,
  value_text text
);
create index if not exists idx_custom_form_answers_submission on custom_form_answers(submission_id);

create table if not exists custom_form_answer_choices (
  answer_id integer not null references custom_form_answers(id) on delete cascade,
  option_id integer not null references custom_form_field_options(id) on delete cascade,
  primary key (answer_id, option_id)
);

-- ===== 20260825080000_payments_foundation.sql =====
-- Community & Commerce track (Track B), item 9: Accounting/Payments
-- foundation - built ahead of item 8 (Store) even though the handoff
-- lists Store first, because the handoff's own item 9 text requires
-- Store's checkout to be wired through this same abstraction rather
-- than inventing a separate "did they pay" flag - the dependency runs
-- the opposite direction from the numbering. A payment ABSTRACTION only
-- - no real payment processor is integrated here, and no raw card data
-- is ever stored. A Main Admin (manage_finances) records real-world
-- payments (cash, check, Venmo, whatever the co-op actually uses)
-- against a charge after the fact; there is no online "pay now" button
-- anywhere in this app.

-- A charge is money owed by a member - a store order, an event
-- registration fee, or a manual charge an admin records by hand
-- (source_type/source_id together point back at the thing that created
-- it, when there is one; both are null for a manual charge).
create table if not exists payment_charges (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  account_id integer references member_accounts(id) on delete set null,
  source_type text not null default 'manual' check (source_type in ('store_order', 'event_registration', 'manual')),
  source_id integer,
  description text not null,
  amount_cents integer not null check (amount_cents >= 0),
  -- Recomputed by utils/payments.js's own recordPayment() from the real
  -- payment_payments rows against this charge every time one is added -
  -- never set directly to 'paid'/'refunded' by a route, so this can
  -- never drift from what was actually recorded.
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_payment_charges_member on payment_charges(member_id);
create index if not exists idx_payment_charges_source on payment_charges(source_type, source_id);

-- One row per real-world payment or refund against a charge - positive
-- amount_cents for a payment, negative for a refund, so a charge's own
-- "amount actually settled" is always a plain SUM() over these, the same
-- "never trust a cached total" principle every other running total in
-- this app already follows (event registration counts, donation
-- quantities claimed, etc.).
create table if not exists payment_payments (
  id integer generated always as identity primary key,
  charge_id integer not null references payment_charges(id) on delete cascade,
  amount_cents integer not null,
  -- 'manual' is every real payment today (recorded by an admin after
  -- money changed hands outside this app); 'stripe_placeholder' exists
  -- only so the abstraction has somewhere to grow into a real processor
  -- later without a schema change - nothing in this codebase sets it yet.
  method text not null default 'manual' check (method in ('manual', 'stripe_placeholder')),
  recorded_by_account_id integer references member_accounts(id) on delete set null,
  note text,
  created_at text not null default now_text()
);
create index if not exists idx_payment_payments_charge on payment_payments(charge_id);

-- ===== 20260825090000_store.sql =====
-- Community & Commerce track (Track B), item 8: Store. Checkout is wired
-- through item 9's own payment_charges/payment_payments abstraction
-- (utils/payments.js) rather than a separate "did they pay" flag on
-- store_orders - the handoff's own explicit instruction, why that
-- foundation was built first.

create table if not exists store_products (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  image_key text,
  price_cents integer not null check (price_cents >= 0),
  -- null = unlimited (a digital/no-inventory item, e.g. a fundraiser
  -- t-shirt pre-order with no cap) - decremented on every paid order,
  -- restored on cancellation, never trusted from a client.
  inventory_count integer,
  availability text not null default 'both' check (availability in ('online', 'in_person', 'both')),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

-- sale_type is the "must be recorded distinctly, not faked as a real
-- online transaction" requirement made structural, not just a status
-- string an admin could get wrong: an in-person sale is created through
-- its own dedicated admin action (routes/admin-store.js's own
-- recordInPersonSale, separate from the member-facing online checkout
-- route) and is paid immediately in that same action, while an online
-- order always starts 'pending' until a Main Admin records the payment
-- through the shared payment_charges abstraction.
create table if not exists store_orders (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  -- Who took the action: the buyer's own account for an online order,
  -- the recording admin's account for an in-person sale (member_id can
  -- be any member, including one with no portal account at all, for an
  -- in-person sale - a co-op kid buying a snack doesn't need a login).
  placed_by_account_id integer references member_accounts(id) on delete set null,
  sale_type text not null check (sale_type in ('online', 'in_person')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'fulfilled', 'cancelled')),
  charge_id integer references payment_charges(id) on delete set null,
  total_cents integer not null check (total_cents >= 0),
  created_at text not null default now_text(),
  fulfilled_at text,
  cancelled_at text
);
create index if not exists idx_store_orders_member on store_orders(member_id);

-- unit_price_cents is a snapshot of store_products.price_cents at order
-- time - a later price change must never retroactively change what a
-- past order shows as charged.
create table if not exists store_order_items (
  id integer generated always as identity primary key,
  order_id integer not null references store_orders(id) on delete cascade,
  product_id integer references store_products(id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null
);
create index if not exists idx_store_order_items_order on store_order_items(order_id);

-- ===== 20260825100000_newsletter.sql =====
-- Community & Commerce track (Track B), item 10: Weekly Newsletter.
-- Content is auto-assembled from real, existing tables (events,
-- announcements, business directory) - see utils/newsletter.js's own
-- assembleContent() - and stored here only once generated, so it can be
-- hand-edited before sending without the source data drifting under it.
-- "Sending" itself is a status change, not a real email dispatch - this
-- app has no email provider configured anywhere, the same reasoning
-- item 9 (Accounting/Payments) already established for not integrating a
-- real payment processor: build the real workflow (assemble, edit,
-- preview, schedule, mark sent, keep a recipient count), stop short of
-- wiring an actual outbound send.

create table if not exists newsletter_issues (
  id integer generated always as identity primary key,
  subject text not null,
  body_html text not null,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  -- A snapshot, not a live query result - "how many accounts would this
  -- have gone to" is meaningful history even after member counts change.
  recipient_count integer,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

-- ===== 20260825110000_notifications.sql =====
-- Community & Commerce track (Track B), item 11: SMS/text notification
-- framework, sharing one underlying "notification" concept with the
-- in-app Notification Center rather than being two unrelated systems -
-- per the handoff's own suggestion. A notification has a type, a
-- recipient, and gets attempted across one or more delivery channels
-- (in_app/email/sms).
--
-- notification_types is the admin-controlled catalog of what kinds of
-- notification the app can generate (seeded below from features that
-- already exist - Newsletter sends, event registration confirmations,
-- forum replies) - not a placeholder list, every key here has a real
-- caller in utils/. auto_send_enabled is the "admin control over which
-- message types actually send automatically" the handoff calls for: a
-- Main Admin can turn a type off without touching code.
create table if not exists notification_types (
  key text primary key,
  label text not null,
  description text not null,
  auto_send_enabled integer not null default 1
);

-- A member's own per-type, per-channel opt-out. Only override rows are
-- stored (like an allowlist would over-store) - an account with no row
-- for a given (type, channel) is enabled by default, matching how a
-- brand-new member should receive notifications without first visiting
-- a settings page. in_app can't be disabled here - the Notification
-- Center itself has no separate opt-out, only email/sms do.
create table if not exists notification_preferences (
  id integer generated always as identity primary key,
  member_account_id integer not null references member_accounts(id) on delete cascade,
  type_key text not null references notification_types(key) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  enabled integer not null default 0,
  unique (member_account_id, type_key, channel)
);

-- One row per notification actually generated for a recipient - this is
-- the Notification Center's own data, read_at is what "unread" means
-- there. link_url is optional context (e.g. the event or thread this is
-- about).
create table if not exists notifications (
  id integer generated always as identity primary key,
  member_account_id integer not null references member_accounts(id) on delete cascade,
  type_key text not null references notification_types(key) on delete set null,
  title text not null,
  body text not null,
  link_url text,
  read_at text,
  created_at text not null default now_text()
);
create index if not exists idx_notifications_account on notifications(member_account_id, created_at desc);

-- One row per channel actually attempted for a notification (in_app is
-- always attempted and always succeeds by construction - it's just the
-- notifications row existing). email/sms go through utils/
-- emailProvider.js / utils/smsProvider.js - provider ABSTRACTIONS, same
-- reasoning utils/payments.js already established for not integrating a
-- real payment processor and utils/newsletter.js for not wiring a real
-- outbound email send: no SMS vendor (Twilio or otherwise) or email
-- vendor is configured anywhere in this app, so every email/sms
-- delivery here records status='skipped' with why, rather than
-- pretending to have sent something real.
create table if not exists notification_deliveries (
  id integer generated always as identity primary key,
  notification_id integer not null references notifications(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email', 'sms')),
  status text not null check (status in ('sent', 'skipped', 'failed')),
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_notification_deliveries_notification on notification_deliveries(notification_id);

-- Seed the catalog itself - every key here has a real caller (see
-- utils/newsletter.js's markSent(), routes/events.js's registration
-- handler, routes/forums.js's reply handler), never a placeholder type
-- with nothing that actually generates it.
insert into notification_types (key, label, description) values
  ('newsletter_sent', 'Newsletter Sent', 'A weekly newsletter issue was sent.'),
  ('event_registration', 'Event Registration', 'Confirmation that a family member is registered for an event.'),
  ('forum_reply', 'Forum Reply', 'Someone replied to a thread you started.')
on conflict (key) do nothing;

-- ===== 20260825120000_photos_publications.sql =====
-- Community & Commerce track (Track B), item 12: Photos/Albums and
-- Publications/Articles.
--
-- Photo privacy is deliberate, not incidental: visibility defaults to
-- 'members' on both an album and (redundantly, on purpose) its own
-- uploaded files being served through an authenticated route rather
-- than a public bucket/local-disk URL - a photo with children in it
-- must never become public just because it was uploaded, per the
-- handoff's own instruction. 'public' is available but is an explicit,
-- separate choice an admin has to make on the album, not a default.
-- Publications share the same visibility column and the same reasoning
-- - an article isn't automatically public just because Publications
-- exists as a feature.
create table if not exists photo_albums (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  visibility text not null default 'members' check (visibility in ('members', 'public')),
  cover_image_key text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists photo_album_photos (
  id integer generated always as identity primary key,
  album_id integer not null references photo_albums(id) on delete cascade,
  image_key text not null,
  caption text,
  uploaded_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_photo_album_photos_album on photo_album_photos(album_id);

create table if not exists publications (
  id integer generated always as identity primary key,
  title text not null,
  body_html text not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  visibility text not null default 'members' check (visibility in ('members', 'public')),
  published_at text,
  author_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

-- ===== 20260825130000_audit_log.sql =====
-- Community & Commerce track (Track B), item 13: Audit Log.
-- who/what/when/what-record for meaningful admin actions - threaded
-- through real actions in already-built features (financial changes in
-- Accounting, deletions and moderation across Store/Custom Forms/Events/
-- Directory/Classifieds/Newsletter/Photos/Publications, admin settings
-- changes in Notifications), not bolted on generically with nothing
-- real to log. Forums already has its own dedicated moderation log
-- (forum_moderation_log, item 6) with its own per-thread/post context
-- and admin view - this table deliberately does not duplicate it.
--
-- Role/permission changes (also called out in the handoff as worth
-- auditing) live in routes/main-admin.js, which is off-limits to this
-- track - see TEAM_B_HANDOFF.md's own hard boundaries.
create table if not exists audit_log (
  id integer generated always as identity primary key,
  actor_account_id integer references member_accounts(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id integer,
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_audit_log_created on audit_log(created_at desc);

-- ===== 20260826000000_announcement_notification_type.sql =====
-- A real request: Main Admin should be able to compose and send a
-- customized announcement to some or all members, and Parent Portal's
-- home page should show current + past announcements sent to that
-- account. Reuses the existing notification_types/notifications/
-- notification_deliveries tables (supabase/migrations/
-- 20260825110000_notifications.sql) rather than a parallel "announcement"
-- table - an announcement IS a notification, same as newsletter_sent/
-- event_registration/forum_reply already are, just triggered by a Main
-- Admin composing one instead of another feature's own automated event.
insert into notification_types (key, label, description) values
  ('announcement', 'Announcement', 'A message Main Admin sent to some or all members.')
on conflict (key) do nothing;

-- ===== 20260826010000_sections.sql =====
-- A real request: group members into named "sections" (e.g. "Teen Co-op",
-- "Homeschool Group A") independent of Family, so Events and Classes can
-- each optionally restrict who can see/register for them to specific
-- sections. A brand new, generic grouping concept - not reusing Family
-- (which already means something else: a household) or Roles (which
-- mean "which portal/permissions", not "which group of the co-op this
-- member belongs to").
create table if not exists sections (
  id integer generated always as identity primary key,
  name text not null unique,
  description text,
  created_at text not null default now_text()
);

create table if not exists member_sections (
  member_id integer not null references members(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (member_id, section_id)
);
create index if not exists idx_member_sections_section on member_sections(section_id);

-- ===== 20260826020000_class_registration_rules.sql =====
-- A real, large request covering class registration: who is allowed to
-- register (parent-on-behalf-of-child, teacher/assistant self-signup,
-- student self-signup), how many teacher/assistant seats a class has,
-- a minimum enrollment (alongside the existing capacity as the max),
-- whether a member can cancel their own registration and whether that
-- refunds automatically, a waitlist position number, and a link from a
-- registration to the payment_charges row it created (if the class is
-- priced) so cancelling an unpaid registration can clear that charge.

alter table classes add column if not exists allow_parent_register integer not null default 1;
alter table classes add column if not exists allow_teacher_register integer not null default 1;
-- Defaults closed - "teachers and class assistants will be able to
-- register, but not the students until allowed" - a Main/Co-op Admin has
-- to explicitly open student self-registration per class.
alter table classes add column if not exists allow_student_register integer not null default 0;
alter table classes add column if not exists teacher_slots integer;
alter table classes add column if not exists assistant_slots integer;
alter table classes add column if not exists min_capacity integer;
alter table classes add column if not exists allow_cancel integer not null default 1;
alter table classes add column if not exists auto_refund_on_cancel integer not null default 0;
alter table classes add column if not exists price_cents integer;
alter table classes add column if not exists price_per text default 'person' check (price_per in ('person', 'family'));

-- A class restricted to specific sections - no rows at all means "every
-- member can see/register", same "empty means unrestricted" convention
-- as event_sections (see the events migration in this same batch).
create table if not exists class_sections (
  class_id integer not null references classes(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (class_id, section_id)
);
create index if not exists idx_class_sections_section on class_sections(section_id);

-- Which numbered spot in the waitlist a 'waitlisted' class_registrations
-- row holds - assigned at insert time (count of already-waitlisted rows
-- for that class + 1) and shifted down for everyone behind when an
-- earlier waitlisted registration is cancelled, so "you are #3 on the
-- waitlist" stays accurate as people ahead of you drop off. Null for a
-- 'confirmed' or 'cancelled' row - the number only ever means something
-- while actually waitlisted.
alter table class_registrations add column if not exists waitlist_position integer;
-- The payment_charges row this registration created, if the class was
-- priced at the time of registration - lets cancelling an unpaid
-- registration clear that same charge (see utils/payments.js's own
-- cancelCharge) instead of leaving an orphaned pending charge behind.
alter table class_registrations add column if not exists charge_id integer references payment_charges(id) on delete set null;

-- 'class_registration' joins 'store_order'/'event_registration'/'manual'
-- as a real charge source - same reasoning as event registrations, a
-- class registration fee is money owed by a member, recorded through the
-- exact same payment_charges/payment_payments abstraction (utils/
-- payments.js), never a parallel "did they pay for this class" flag.
alter table payment_charges drop constraint if exists payment_charges_source_type_check;
alter table payment_charges add constraint payment_charges_source_type_check
  check (source_type in ('store_order', 'event_registration', 'class_registration', 'manual'));

-- ===== 20260826030000_class_waitlist_notification_type.sql =====
-- A real request: class registration gets a real waitlist (position
-- number tracked, see 20260826020000_class_registration_rules.sql) - and
-- when someone ahead cancels, the next waitlisted student is promoted to
-- confirmed automatically (routes/parent-portal.js's own unregister
-- route). This is what that promotion notifies the registering account
-- through, same "insert into notification_types, on conflict do nothing"
-- pattern as 20260826000000_announcement_notification_type.sql.
insert into notification_types (key, label, description) values
  ('class_waitlist_promoted', 'Moved Off Waitlist', 'A waitlisted class registration was promoted to confirmed because a spot opened up.')
on conflict (key) do nothing;

-- ===== 20260826040000_events_registration_rules.sql =====
-- A real, large request extending the existing Events module (see
-- 20260825030000_events_module.sql) with registration rules, categories,
-- section restriction, guest registration, and check-in/out - the Events
-- half of the same request the class-registration migration
-- (20260826020000) covered for Classes. Draft/publish (`status`) and
-- capacity already existed; this adds the rest: a registration open/
-- close window, a family cap alongside the existing per-person capacity,
-- age/grade restriction, per-person/per-family pricing, a real managed
-- category list, section restriction (view AND register, unlike a
-- class's registration-only restriction - "select sections only that can
-- view or signup for events"), whether adult or child members may be
-- registered, member-submitted events awaiting approval, lightweight
-- guest registration, and check-in/out tracking.

-- Main-Admin-managed, same shape/reasoning as `sections` - a fixed list
-- an event picks one of, so the calendar can filter/color-code by
-- category instead of every admin typing their own free text. The
-- original `events.category` free-text column is left in place
-- (untouched, still populated on old rows) rather than migrated - new
-- events use category_id instead; nothing reads the old text column once
-- category_id is set.
create table if not exists event_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  color text not null default '#EE9A4D',
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists category_id integer references event_categories(id) on delete set null;

alter table events add column if not exists registration_opens_at text;
alter table events add column if not exists registration_closes_at text;
-- Alongside the existing per-person `capacity` - "limit number of
-- people, number of families" are two separate caps a family-heavy
-- event (one signup covers several people) needs independently.
alter table events add column if not exists family_capacity integer;
-- Comma-joined list of utils/membership.js's own GRADE_OPTIONS strings -
-- reuses the Membership Form's grade vocabulary (what members.grade_level
-- actually stores), not classes.age_group's own different GRADE_LEVELS
-- list, since this is checked directly against a real member's
-- grade_level. Null/empty means unrestricted, same "empty means every
-- grade" convention as every other optional restriction here.
alter table events add column if not exists age_group text;
-- "be able to limit whether parents or kids can register for an event" -
-- checked against the member being registered's own member_type (parent/
-- admin count as "adult", student counts as "child"), not against which
-- portal the person submitting the registration is signed into (an event
-- registration can be submitted from any portal for any of the
-- submitter's own family).
alter table events add column if not exists allow_adult_register integer not null default 1;
alter table events add column if not exists allow_child_register integer not null default 1;
alter table events add column if not exists price_cents integer;
alter table events add column if not exists price_per text default 'person' check (price_per in ('person', 'family'));

-- Member-submitted events ("members should be able to add events for
-- approval"). Null submitted_by_account_id = admin-created, same as
-- every event before this migration. approval_status is independent of
-- `status` (draft/published/cancelled) - a submitted event starts
-- 'draft' + 'pending' and stays invisible to everyone but its submitter
-- and Main Admin's approval queue until a Main Admin either approves it
-- (still draft - a Main Admin still has to actually publish it, same as
-- any admin-created event) or rejects it.
alter table events add column if not exists submitted_by_account_id integer references member_accounts(id) on delete set null;
alter table events add column if not exists approval_status text not null default 'approved' check (approval_status in ('pending', 'approved', 'rejected'));

-- An event restricted to specific sections - no rows at all means "every
-- member can see/register", same "empty means unrestricted" convention
-- as class_sections (see the class-registration migration). Unlike a
-- class (which always lists on the schedule and only blocks
-- registration), an unlisted-section member can't see this event at all
-- - routes/events.js's own listing/detail queries filter on this.
create table if not exists event_sections (
  event_id integer not null references events(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (event_id, section_id)
);
create index if not exists idx_event_sections_section on event_sections(section_id);

-- Check-in/out (name tag barcode scan, or a manual Present/Absent toggle
-- on the registrations roster) - null check_in means "not checked in",
-- same as this app's existing attendance.check_in_time convention.
alter table event_registrations add column if not exists checked_in_at text;
alter table event_registrations add column if not exists checked_out_at text;
-- Same waitlist-position tracking as class_registrations.waitlist_position
-- (see the class-registration migration's own comment) - assigned at
-- insert, shifted down for everyone behind on a cancel or promotion.
alter table event_registrations add column if not exists waitlist_position integer;
-- The payment_charges row this registration created, if the event was
-- priced at the time of registration - same reasoning/shape as class_
-- registrations.charge_id (lets cancelling an unpaid registration clear
-- the charge instead of leaving it orphaned). 'event_registration' was
-- already a valid payment_charges.source_type before this migration (see
-- the class-registration migration's own comment on that constraint).
alter table event_registrations add column if not exists charge_id integer references payment_charges(id) on delete set null;

-- Lightweight guest registration ("guest registration for events (admin
-- permission)") - a real attendee with no `members` row at all, added by
-- a staff member holding the register_guests portal permission (db/
-- bootstrapPg.js), not self-service. No barcode/name tag exists for a
-- guest, so guest check-in/out is manual-only (see the roster page), not
-- scannable the way a real member's is.
create table if not exists event_guest_registrations (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  guest_name text not null,
  guest_email text,
  guest_phone text,
  registered_by_account_id integer references member_accounts(id) on delete set null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  checked_in_at text,
  checked_out_at text,
  created_at text not null default now_text()
);
create index if not exists idx_event_guest_registrations_event on event_guest_registrations(event_id);

-- Same "insert into notification_types, on conflict do nothing" pattern
-- as 20260826030000_class_waitlist_notification_type.sql - what an
-- event's own waitlist promotion (utils/events.js's promoteNextWaitlisted)
-- notifies the registering account through, and what a Main Admin's
-- approve/reject decision on a member-submitted event notifies the
-- submitter through.
insert into notification_types (key, label, description) values
  ('event_waitlist_promoted', 'Moved Off Waitlist', 'A waitlisted event registration was promoted to confirmed because a spot opened up.'),
  ('event_submission_decided', 'Submitted Event Reviewed', 'A Main Admin approved or rejected an event a member submitted.')
on conflict (key) do nothing;

-- ===== 20260827000000_forum_to_chat_rename.sql =====
-- A real request: "Change forum to chat, everywhere!" - a display-text-
-- only rename (the Forum/discussion-board feature itself, its routes,
-- tables, and the notification_types.key 'forum_reply' all stay exactly
-- as they are - only what a member actually reads changes). Every view/
-- route string was updated directly; this is the one piece of display
-- text that already shipped as seeded data in an earlier migration
-- (20260825110000_notifications.sql) and so has to be updated in place
-- rather than edited retroactively.
update notification_types set label = 'Chat Reply', description = 'Someone replied to a thread you started.' where key = 'forum_reply';

-- ===== 20260827020000_resource_links.sql =====
-- Resource Links - Student Portal item: "resource links" tab. A short,
-- admin-curated list of external links (a Google Classroom folder, a
-- reading list, a permission-slip form, etc.), not a document library or
-- checkout system (that's the EXISTING Library feature - utils/
-- library.js - a different, physical-item-checkout concept). role_key
-- optionally scopes a link to one portal's audience, the same
-- null-means-everyone convention routes/main-admin-announcements.js's own
-- roleKey already uses for "Send to"; left null a link shows up for every
-- signed-in portal account, same as an unscoped announcement.
create table if not exists resource_links (
  id integer generated always as identity primary key,
  title text not null,
  url text not null,
  description text,
  role_key text references roles(key) on delete cascade,
  position integer not null default 0,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_resource_links_role on resource_links(role_key);

-- ===== 20260827030000_babysitter_directory.sql =====
-- Babysitter Directory - a real request: "Add a Babysitter directory. It
-- should appear on parent portal to view directory. Parents can view or
-- create a profile for their child as well to be a babysitter. Requests
-- are sent for approval to main admin. Students can also create their
-- own baby sitter profile on the student portal, submit for approval for
-- any changes or submissions." One profile per member (a family's own
-- teen, or the student themselves) - never a new "babysitter" identity
-- separate from the existing members table, the same "don't invent a
-- parallel person record" rule every other feature in this app follows.
--
-- EVERY submission and edit needs Main Admin approval (confirmed with
-- the requester) - status resets to 'pending' on any edit, the same
-- "an edit is really just a new submission" rule as most moderation
-- queues, rather than letting an edit silently bypass review.
create table if not exists babysitter_profiles (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  age_grade text,
  availability text,
  experience text,
  certifications text,
  hourly_rate text,
  contact_method text,
  -- Local-disk or Supabase Storage key (utils/storage.js's own
  -- convention), proxied through routes/babysitters.js's own
  -- authenticated /babysitters/:id/photo route - never a public bucket
  -- URL, same reasoning as routes/photos.js.
  photo_key text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  decided_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_babysitter_profiles_status on babysitter_profiles(status);

insert into notification_types (key, label, description) values
  ('babysitter_submission_decided', 'Babysitter Profile Reviewed', 'A Main Admin approved or rejected a babysitter profile submission or edit.')
on conflict (key) do nothing;

-- ===== 20260827040000_family_homeschool_duration.sql =====
-- A real request: "on the membership form, ask how long the family has
-- been homeschooling." Free-text rather than a strict number/date - "3
-- years", "since 2019", "this is our first year" are all real answers a
-- family might give, and the admin-facing form has no need to parse it.
alter table families add column if not exists homeschool_duration text;

-- ===== 20260827050000_class_enrollment_registered_at.sql =====
-- A real request: "on class rosters each student member line should
-- have registration date/time." class_enrollments never tracked when a
-- student was actually added to a class - just the (class_id,
-- student_id) pair itself. Existing rows backfill to the migration's own
-- run time (there's no way to recover their real add date), but every
-- enrollment from here forward gets a real timestamp.
alter table class_enrollments add column if not exists created_at text not null default now_text();

-- ===== 20260827060000_resource_link_categories.sql =====
-- A real request: "resource links should have add category button on
-- admin side. and add resource button. add resource button should pop
-- up with a window that asks for city and state, title, description and
-- website, category and save. list shows up categorized below. members
-- can submit resource links for approval. admin side should have tab
-- under resource links for approvals." Same admin-managed
-- add/delete-only category shape as admin_positions - see utils/
-- adminPositions.js's own comment for the pattern this mirrors.
create table if not exists resource_link_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table resource_links add column if not exists category_id integer references resource_link_categories(id) on delete set null;
alter table resource_links add column if not exists city text;
alter table resource_links add column if not exists state text;
-- 'approved' (admin-added, or a member submission an admin has approved)
-- vs 'pending' (a member submission awaiting review) - the Approvals tab
-- is just this column filtered to 'pending'. Denying a submission deletes
-- its row outright rather than adding a third status - there's nothing
-- useful left to keep once a submission is rejected, same as Main
-- Admin's own event/classified/directory request flows elsewhere in this
-- app that just delete on deny.
alter table resource_links add column if not exists status text not null default 'approved';
alter table resource_links add column if not exists submitted_by_member_id integer references members(id) on delete set null;
create index if not exists idx_resource_links_category on resource_links(category_id);
create index if not exists idx_resource_links_status on resource_links(status);

-- ===== 20260827080000_membership_approvals.sql =====
-- A real request: "under members in main admin portal there should be a
-- tab that says approvals. this is where new membership requests
-- appear... each member line should have approve button, deny button
-- and trash can symbol to delete the request. there should be another
-- tab under main admin members that says settings. this will have an
-- approval and deny letter that can be edited by admin. these letters
-- are sent automatically went approve or deny buttons are clicked."
--
-- 'denied' is a new status alongside member_accounts' existing pending/
-- active/suspended - distinct from actually deleting the row (the trash
-- can button, routes/main-admin-members.js's own deleteApprovalRequest):
-- a denied request stays visible/auditable, just never grants portal
-- access (middleware/portalAuth.js's loadPortalSession only ever loads
-- an 'active' account, same as it already does for 'pending').
alter table member_accounts drop constraint if exists member_accounts_status_check;
alter table member_accounts add constraint member_accounts_status_check check (status in ('pending', 'active', 'suspended', 'denied'));

-- The admin-editable Approval/Denial letter text - a real request: "this
-- will have an approval and deny letter that can be edited by admin."
-- Two fixed rows (kind is the primary key, not an auto-id list like
-- admin_positions) since there are exactly two letters, ever - no
-- add/delete UI needed, just edit-in-place. {{name}} in the body is
-- substituted with the applicant's own name at send time (utils/
-- membershipApprovals.js's own renderTemplate).
create table if not exists membership_letter_templates (
  kind text primary key check (kind in ('approval', 'denial')),
  subject text not null,
  body text not null
);
insert into membership_letter_templates (kind, subject, body) values
  (
    'approval',
    'Welcome to Sanford Homeschoolers!',
    'Hi {{name}},

Great news - your membership request has been approved! You can now log in to the member portal with the email and password you registered with.

We''re so glad to have your family join us.

Welcome aboard!'
  ),
  (
    'denial',
    'About Your Membership Request',
    'Hi {{name}},

Thank you for your interest in Sanford Homeschoolers. After review, we''re unable to approve your membership request at this time.

If you have any questions, please reach out to an admin directly.'
  )
on conflict (kind) do nothing;

-- Same "insert into notification_types, on conflict do nothing" pattern
-- every other feature's own migration already uses (see utils/
-- notifications.js's own header comment) - the actual send happens
-- through the existing notify() entry point, no new delivery mechanism.
insert into notification_types (key, label, description) values
  ('membership_approved', 'Membership Approved', 'Your membership request was approved.'),
  ('membership_denied', 'Membership Request Denied', 'Your membership request was denied.')
on conflict (key) do nothing;

-- ===== 20260827090000_classified_categories.sql =====
-- Main Admin Classifieds (Community & Commerce track, item 4) - a real
-- request: "Only admin can add classifieds categories (same Add Category
-- popup pattern to add/delete). Members must choose a category when
-- creating a listing. Admin Classifieds gets tabs: Categories, Archive,
-- Requests." Same admin-managed add/delete-only category shape as
-- resource_link_categories (see supabase/migrations/
-- 20260825060000_forums.sql's sibling, 20260825050000-era resource links
-- migration) - classified_listings.category_id replaces its old free-text
-- `category` column going forward; that old column is left in place,
-- unused, rather than dropped, so a real deployed project never loses
-- historical data on migrate.
create table if not exists classified_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table classified_listings add column if not exists category_id integer references classified_categories(id) on delete set null;
create index if not exists idx_classified_listings_category on classified_listings(category_id);

-- ===== 20260827100000_directory_categories.sql =====
-- Main Admin Business Directory (Community & Commerce track, item 4) - a
-- real request: "Business Directory gets tabs: Directory, Requests,
-- Archive. Directory tab gets the same Add Category popup pattern
-- (admin-only add/delete categories)." Same admin-managed add/delete-only
-- category shape as classified_categories (see supabase/migrations/
-- 20260827090000_classified_categories.sql's own comment for the
-- reasoning this mirrors) - business_directory_listings.category_id
-- replaces its old free-text `category` column going forward; that old
-- column is left in place, unused, rather than dropped, so a real
-- deployed project never loses historical data on migrate.
create table if not exists business_directory_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table business_directory_listings add column if not exists category_id integer references business_directory_categories(id) on delete set null;
create index if not exists idx_business_directory_listings_category on business_directory_listings(category_id);

-- ===== 20260827110000_newsletter_custom_note.sql =====
-- Weekly Newsletter - a real request: "Add a 'Customize Newsletter'
-- action where admin writes their own note/letter that appears before
-- the automatic content." Kept as its own column, separate from
-- body_html (the auto-assembled section) - utils/newsletter.js's own
-- regenerate() only overwrites body_html, so re-assembling from live
-- data never silently wipes an admin's hand-written note the way it
-- would if the note lived inside body_html itself.
alter table newsletter_issues add column if not exists custom_note text;

-- ===== 20260828000000_membership_form_fields.sql =====
-- A real request: "under members in main admin portal there should be a
-- settings tab for editing and adding parts of the membership form."
-- Admin-defined extra questions, shown after the fixed Name/Email/Phone
-- (parent) or Name/Birthday/Grade/Medical Notes (child) fields already
-- built into the Membership Form/Add Member forms (views/member-intake-
-- form.ejs) and the public self-registration application (views/portal-
-- register.ejs) - both share this same field set via utils/
-- membershipFormFields.js, so an admin only has to define a field once
-- for it to show up everywhere a family gets entered into the system.
--
-- `target` splits fields between the Parent/Guardian block and the
-- Student block, since those are two entirely separate repeatable
-- sections on both forms. `options` is a JSON array of strings, used
-- only when field_type = 'dropdown' (mirrors the "JSON blob for a
-- choice list" convention supabase/migrations/20260825070000_custom_forms.sql
-- already uses for its own field options).
create table if not exists membership_form_fields (
  id integer generated always as identity primary key,
  target text not null check (target in ('parent', 'child')),
  field_key text not null,
  label text not null,
  field_type text not null default 'short_text' check (field_type in ('short_text', 'long_text', 'dropdown', 'checkbox')),
  options text,
  is_required boolean not null default false,
  position integer not null default 0,
  created_at text not null default now_text()
);
create unique index if not exists idx_membership_form_fields_key on membership_form_fields(target, field_key);

-- One row per (field, member) - a parent's or child's answer to one
-- admin-defined question. member_id cascades on delete, same as every
-- other per-member detail table in this app (e.g. member_sections).
create table if not exists membership_form_field_values (
  id integer generated always as identity primary key,
  field_id integer not null references membership_form_fields(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  value text,
  unique (field_id, member_id)
);
create index if not exists idx_membership_form_field_values_member on membership_form_field_values(member_id);

-- ===== 20260828010000_announcement_log.sql =====
-- Real requests: "main admin and co-op admin announcements should be
-- communication... at the bottom of announcements it says past
-- announcements, where it lists the announcements that have been sent
-- and next to it it shows which portals it was sent to, date and time.
-- public homepage past announcements doesn't need its own section. They
-- all show us under the same past announcements log."
--
-- Both Co-op Admin's and Main Admin's own Announcements/Communication
-- pages (routes/admin-announcements.js, routes/main-admin-
-- announcements.js) already send through the same notify() mechanism
-- (Notification Center rows) or the same public `announcements` table -
-- neither one records which target(s) a single send actually went to,
-- so there was no reliable way to show "sent to Parent + Student" next
-- to a past send without re-deriving it from raw notification rows
-- (fragile - two different sends with the same title/body/timestamp
-- would collapse together). One row per send here instead, targets
-- stored as a JSON array of strings ('parent', 'student', 'public',
-- etc. - role keys, or the literal string 'public'/'everyone') so the
-- unified log can show it plainly regardless of which portal sent it or
-- what it went to.
create table if not exists announcement_log (
  id integer generated always as identity primary key,
  title text not null,
  body text not null,
  targets text not null,
  recipient_count integer not null default 0,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_at text not null default now_text()
);
create index if not exists idx_announcement_log_created on announcement_log(created_at desc);

-- ===== 20260828010000_event_wizard_fields.sql =====
-- Create New Event wizard (Main Admin) - a real request: match a
-- reference mockup's 5-step event-creation flow (Details / Date & Time /
-- Location / Tickets / Additional). Most of that mockup's fields already
-- exist on `events` from earlier migrations (title, description,
-- category, location, dates, capacity, pricing, age_group, sections); the
-- ones that don't are added here. No uniqueness constraint on slug - this
-- app has no public "/events/:slug" route yet, so it's a plain editable
-- field, not a routing key.
alter table events add column if not exists slug text;
alter table events add column if not exists event_type text;
alter table events add column if not exists short_description text;
alter table events add column if not exists language text;
alter table events add column if not exists organized_by text;
alter table events add column if not exists tags text;

-- ===== 20260828020000_email_campaigns.sql =====
-- Communication > Email tab (item 12) - a real request: "there should be
-- a filter that filters the member list by section, role, if there
-- registered for classes or not, age group, grade level, parent,
-- student, teacher etc, select all, select none... create email button
-- takes you to a new screen where you can compose... reply to box...
-- option to send right away or schedule for later." Reuses the same
-- notification_types/notifications plumbing utils/announcements.js and
-- utils/newsletter.js already use (an email IS a notification, same as
-- announcement/newsletter_sent already are) rather than a parallel send
-- mechanism.
--
-- email_campaigns is the record of a composed send, mirroring
-- newsletter_issues' own status/scheduled_at/sent_at shape (supabase/
-- migrations/20260825100000_newsletter.sql) - "Schedule" saves a row with
-- status='scheduled' and no dispatch yet (no real cron/vendor is wired up
-- anywhere in this app - see utils/emailProvider.js's own header comment
-- - so, same as a scheduled newsletter issue, nothing sends automatically
-- until an admin manually sends it). recipient_account_ids is a JSON
-- array captured at compose time (from the filtered/checked member list)
-- so a scheduled send still reaches exactly who was selected, even if the
-- filters would produce a different list by the time it's actually sent.
insert into notification_types (key, label, description) values
  ('email_campaign', 'Email', 'A targeted email Main Admin or Co-op Admin sent to a filtered list of members.')
on conflict (key) do nothing;

create table if not exists email_campaigns (
  id integer generated always as identity primary key,
  subject text not null,
  body_html text not null,
  reply_to text,
  recipient_account_ids text not null default '[]',
  recipient_count integer not null default 0,
  status text not null default 'sent' check (status in ('scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_email_campaigns_created on email_campaigns(created_at desc);

-- ===== 20260828030000_text_campaigns.sql =====
-- Communication > Text tab (item 13) - a real request: "text tab should
-- have the same structure as email but simpler, a text box with a 50
-- word cap." Same filtered-member-list/select-all-none/compose/send-or-
-- schedule structure as Communication > Email (utils/emailComposer.js's
-- own listRecipientCandidates() is reused as-is - the filter facets are
-- identical), but text_campaigns has no subject or reply_to column since
-- a text message is just a short plain-text body, not an email.
insert into notification_types (key, label, description) values
  ('text_message', 'Text Message', 'A short text Main Admin or Co-op Admin sent to a filtered list of members.')
on conflict (key) do nothing;

create table if not exists text_campaigns (
  id integer generated always as identity primary key,
  body text not null,
  recipient_account_ids text not null default '[]',
  recipient_count integer not null default 0,
  status text not null default 'sent' check (status in ('scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_text_campaigns_created on text_campaigns(created_at desc);

-- ===== 20260828040000_babysitter_directory_polish.sql =====
-- Main Admin > Babysitters polish (item 15) - a real request: "babysitter
-- tab should have babysitter, approvals and settings tab. add a babysitter
-- profile button that pops up and picks a member (auto fills the rest of
-- the form)... directory should be cards, alphabetical by last name,
-- with photo, name, grade and phone number... add a call or text
-- preference field."
--
-- contact_method (existing) is a free-text "how to reach me" field
-- ("Text (555) 555-1234") - contact_preference is the new, separate
-- structured Call/Text/Either choice the request asks for, so a directory
-- view could one day filter/sort by it without parsing free text.
alter table babysitter_profiles add column if not exists contact_preference text check (contact_preference in ('call', 'text', 'either'));

-- ===== 20260828050000_event_locations.sql =====
-- Main Admin > Events Settings (item 8) - a real request: "buttons for
-- add/edit category, add/edit location. Both create a popup that allows
-- you to add/edit or delete categories or locations. Locations will then
-- also be a dropdown menu of choices when creating events instead of
-- typing in addresses when creating each event." Same shape/reasoning as
-- event_categories (20260826040000_events_registration_rules.sql) - a
-- fixed, Main-Admin-managed list an event picks one of instead of every
-- admin typing their own free text. The original events.location
-- free-text column is left in place (untouched, still populated on old
-- rows) rather than migrated - new events use location_id instead,
-- same "legacy text column stays, new events use the FK" pattern
-- events.category/category_id already established.
create table if not exists event_locations (
  id integer generated always as identity primary key,
  name text not null unique,
  address text,
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists location_id integer references event_locations(id) on delete set null;

-- ===== 20260829010000_event_settings.sql =====
-- Main Admin > Events > Settings (item 9) - "add the settings exactly as
-- shown in the screenshots." One singleton settings row, same shape as
-- site_settings (20260825020000_portal_platform_foundation.sql): a Main
-- Admin can edit these without touching code. Several of these fields
-- (waitlist position visibility, credit adjustments, sub-admin role
-- scoping) don't have a system behind them yet in this app - they're
-- stored so the setting exists and is ready to wire up once that system
-- does, the same "controls X once a real feature exists" pattern the
-- newsletter's own weekly-send-schedule setting already uses. The ones
-- that do have something to control today (default calendar view, family
-- event submission gate + auto-approve, notification email, public-by-
-- default) are wired live in routes/admin-events.js and routes/events.js.
create table if not exists event_settings (
  id integer primary key default 1 check (id = 1),
  default_calendar_view text not null default 'list' check (default_calendar_view in ('calendar', 'list')),
  show_waitlist_position integer not null default 1,
  reminder_days_before integer not null default 10,
  credit_on_family_cancel integer not null default 0,
  credit_on_admin_cancel integer not null default 1,
  subadmin_edit_locations integer not null default 1,
  subadmin_edit_categories integer not null default 0,
  family_submit_events text not null default 'yes' check (family_submit_events in ('yes', 'auto_approve', 'no')),
  submit_notification_email text,
  family_manage_price_options integer not null default 0,
  family_manage_own_events integer not null default 1,
  family_events_public_default integer not null default 0,
  updated_at text not null default now_text()
);
insert into event_settings (id) values (1) on conflict (id) do nothing;

-- Categories screenshot table has an "Allow Sync" column per row.
alter table event_categories add column if not exists allow_sync integer not null default 1;

-- Item 11 - "attendance button on each line should go to a view exactly
-- like class check in/out... a roster grid view for manually changing
-- p, a, l." Event registrations only ever tracked binary checked_in_at/
-- checked_out_at (present or not) - same 3-state present/late/absent
-- shape utils/attendance.js's own class attendance already uses, added
-- here as its own column since check-in/out and a P/A/L call aren't the
-- same thing (a member can be checked in but still marked Late).
alter table event_registrations add column if not exists attendance_status text check (attendance_status in ('present', 'late', 'absent'));
alter table event_guest_registrations add column if not exists attendance_status text check (attendance_status in ('present', 'late', 'absent'));

-- ===== 20260829020000_photo_submission_review.sql =====
-- Main Admin homepage (item 6) - "a 2nd count display for pending
-- requests such as... photo submissions... each name should be able to
-- click and go straight to that request page to view and approve
-- submissions." routes/photos.js already lets any signed-in portal
-- account upload photos straight into a shared album with zero review
-- step - a real gap once the homepage is claiming there's something to
-- approve. status defaults to 'approved' so every existing row and every
-- admin-added photo (routes/admin-photos.js) is unaffected; only the
-- member self-serve upload route sets 'pending' going forward.
alter table photo_album_photos add column if not exists status text not null default 'approved' check (status in ('pending', 'approved', 'rejected'));

-- ===== 20260830010000_student_pets.sql =====
-- Student Portal > Pets - a real request: "create a personal pet activity
-- for students. They can choose a pet, choose a few features and save.
-- Then they can name their pet, feed it, play with it, bathe it." One
-- pet per student member (unique on member_id), same "re-derive from
-- req.portalAccount.id, never trust a client-supplied id" scoping every
-- other Student Portal route already uses.
--
-- `look` is a plain text key into utils/pets.js's own PET_LOOKS catalog -
-- a real request ("higher level graphics and glossy like my original
-- screenshots... we need to go that route and do better") replaced the
-- original 5-trait mix-and-match system (species/ears/eyes/mouth/
-- accessory columns) with real photorealistic pet images (cropped
-- directly from the reference the user provided - see
-- public/images/pets/'s own README), so there's one "look" choice
-- instead of five independent trait cycles - a photoreal render can't be
-- decomposed into swappable parts the way flat SVG could.
--
-- Care stats (hunger/happiness/cleanliness) are intentionally NOT stored
-- as mutable numbers - they're computed on read from how long it's been
-- since last_fed_at/last_played_at/last_bathed_at (utils/pets.js's own
-- careStats()), so there's nothing to drift out of sync and no cron job
-- needed to "decay" anything. xp/coins stay simple running totals -
-- decorative progress (no shop to spend coins in yet), incremented a
-- fixed amount per care action.
create table if not exists student_pets (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  name text not null default 'My Pet',
  look text not null default 'cat_black',
  xp integer not null default 0,
  coins integer not null default 25,
  last_fed_at text,
  last_played_at text,
  last_bathed_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

-- ===== 20260830020000_reading_log.sql =====
-- Student Portal > Reading Competition - a real request: "there will be a
-- reading log on this page for students to fill out and earn points.
-- students will compete with other students." One row per reading
-- session a student logs (not one row per student, unlike student_pets)
-- since the dashboard needs a scrollable history of entries and streaks/
-- weekly totals are computed by summing rows, not a single mutable
-- counter - same "compute on read" philosophy as student_pets' care
-- stats (see that migration's own comment): points/streak/level/
-- achievements all derive from this table in utils/reading.js rather
-- than being stored redundantly, so there's nothing to drift out of
-- sync. log_date is the date the reading happened (student-entered, may
-- not be today), separate from created_at (when the row was inserted).
create table if not exists reading_logs (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  book_title text not null,
  hours numeric not null,
  notes text,
  log_date text not null,
  created_at text not null default now_text()
);

create index if not exists reading_logs_member_id_idx on reading_logs (member_id);

-- ===== 20260830030000_game_stats.sql =====
-- Student Portal > Games header stats - a real request: "include games
-- played, high score, current streak bar at the top right." Same
-- "compute on read" approach as reading_logs/student_pets (see those
-- migrations' own comments): raw event rows here, with
-- utils/gameStats.js deriving the played-count/streak/high-score from
-- them rather than maintaining mutable counters that could drift.
--
-- game_plays gets one row every time a student opens a game's play page
-- (routes/student-portal.js's GET /games/play/:key) - an honest, simple
-- proxy for "played this game" across all 15 games (most of which have
-- no natural in-game "finished" event to hook instead).
--
-- game_scores only gets rows from the handful of games that actually
-- produce a comparable numeric result (Snake, Avoid the Obstacles,
-- Trivia Quiz, Typing Race - see utils/gameStats.js's own SCORING_GAMES)
-- via their own JS posting to POST /student/games/score when a round
-- ends. The header's single "High Score" stat is just the best row here
-- across any of those games, labeled with which game it came from -
-- deliberately not attempting to make wildly different games (points vs
-- words-per-minute) comparable in any more rigorous way.
create table if not exists game_plays (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  game_key text not null,
  played_at text not null default now_text()
);
create index if not exists game_plays_member_id_idx on game_plays (member_id);

create table if not exists game_scores (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  game_key text not null,
  score integer not null,
  achieved_at text not null default now_text()
);
create index if not exists game_scores_member_id_idx on game_scores (member_id);

-- ===== 20260830040000_reading_goal.sql =====
-- Student Portal > Reading Challenge - a real request: "is there a button
-- for setting your reading goal?" The weekly goal used to be a single
-- hardcoded constant (utils/reading.js's own WEEKLY_GOAL_HOURS) shared by
-- every student; this lets each student set their own. One row per
-- student (unique on member_id, same pattern as student_pets), missing
-- row = the default goal - utils/reading.js's getWeeklyGoal() falls back
-- to WEEKLY_GOAL_HOURS rather than requiring a row to exist up front.
create table if not exists reading_goals (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  weekly_goal_hours numeric not null default 7,
  updated_at text not null default now_text()
);

-- ===== 20260830050000_nature_news.sql =====
-- Student Portal > Nature News - a real request: "students can submit
-- descriptions and one image of something they discovered in nature...
-- main admin must approve. then it will appear on student portal
-- homepage." Same pending/approved/rejected review pattern as
-- photo_album_photos and babysitter_profiles (see those migrations'
-- own header comments) - one row per submission, member_id NOT unique
-- (a student can submit many discoveries over time, unlike
-- babysitter_profiles' one-per-student shape).
create table if not exists nature_news_posts (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  description text not null,
  image_key text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at text not null default now_text(),
  decided_at text,
  decided_by_account_id integer references member_accounts(id) on delete set null
);

create index if not exists nature_news_posts_member_id_idx on nature_news_posts (member_id);
create index if not exists nature_news_posts_status_idx on nature_news_posts (status);

-- ===== 20260830060000_spelling_bee.sql =====
-- Student Portal > Spelling Bee - a real request: "this page will have a
-- spelling game with vocabulary words for every grade level. grade
-- level on students member profile determines their vocabulary level."
-- One row per completed round (not a mutable per-student counter) -
-- same "raw event rows, derive totals on read" philosophy as
-- game_scores/reading_logs - so the Leaderboard's "top 5 highest
-- spelling bee points" can just SUM these per member.
create table if not exists spelling_scores (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  correct_count integer not null,
  round_total integer not null,
  level text not null,
  achieved_at text not null default now_text()
);

create index if not exists spelling_scores_member_id_idx on spelling_scores (member_id);

-- ===== 20260831010000_substitute_assignments_vacancy_slot_type.sql =====
-- Floater Assignments - a real request: "if class assistant says 1 and
-- there are 0 assistants signed for that class, then the positions
-- should appear on the floater list each week until someone is added as
-- an assistant to that class roster... this should work for number of
-- teachers as well." A class's teacher_slots/assistant_slots (already on
-- the classes table, previously only used to cap self-registration
-- signups) now also drive a standing "still needs to be filled" slot on
-- the Floater Assignments board, alongside the existing permanent job
-- ('job') and missing-teacher-today ('class') slot types - see
-- utils/substitutes.js's own classVacancySlotId/classVacancySlots for
-- how these get generated and assigned through the exact same
-- substitute_assignments table/UI as everything else on that board.
alter table substitute_assignments drop constraint if exists substitute_assignments_slot_type_check;
alter table substitute_assignments add constraint substitute_assignments_slot_type_check check (slot_type in ('class', 'job', 'vacancy'));

-- ===== 20260901010000_class_edit_settings_reorg.sql =====
-- Several real requests bundled into one class-edit reorganization:
--
-- "there shouldn't be a public and internal class description. just one
-- class description" - classes.notes (admin-only) and classes.description
-- (shown to parents) merge into a single classes.description, kept
-- parent-visible (the user's own call - see this migration's PR/session
-- notes). Existing notes content is intentionally NOT copied into
-- description - concatenating admin-only notes onto a field that's shown
-- to parents would leak whatever was written there for internal eyes only.
alter table classes drop column if exists notes;

-- "charged per dropdown, should list, students, students and teachers/
-- Assistants" - clarified: the existing Person/Family billing choice was
-- actually an EVENTS concept (siblings sharing one charge) that had
-- leaked onto the class form too; classes never actually support that
-- family-shared-charge behavior going forward (events keep their own,
-- separate person/family option, untouched by this migration). A class's
-- price_per now instead controls WHO gets charged at all: only the
-- enrolled students, or students AND any teacher/assistant who signs up
-- for it too (e.g. to help cover the cost of supplies) - see
-- utils/classRegistration.js's chargeForConfirmedRegistration and
-- routes/teacher-portal.js's own self-signup route.
-- Drop the OLD constraint (the pre-existing Person/Family check) before
-- the update below, not after - real production data still holding
-- legacy 'person'/'family' values would otherwise have the update itself
-- rejected by that old constraint before it ever got the chance to fix
-- the row up to a value the new constraint accepts.
alter table classes drop constraint if exists classes_price_per_check;
update classes set price_per = 'students' where price_per is null or price_per not in ('students', 'students_and_staff');
alter table classes alter column price_per set default 'students';
alter table classes add constraint classes_price_per_check check (price_per in ('students', 'students_and_staff'));

-- Mirrors class_registrations.charge_id (students) - lets a teacher/
-- assistant who paid to join a 'students_and_staff'-priced class have
-- that charge found and cancelled if they're later removed from the
-- roster, the same "don't leave an orphaned pending charge behind"
-- guarantee removeStaff already needs.
alter table class_staff add column if not exists charge_id integer references payment_charges(id) on delete set null;

-- ===== 20260901020000_name_tag_request_new_tag_type.sql =====
-- Real request: "co-op admin portal name tag request form. options are
-- schedule change and lost name tag. add new name tag as option." Widens
-- name_tag_requests.request_type to also accept 'new_tag' - a member who
-- never had a tag printed yet (not lost, not a schedule change) - for the
-- public Name Tag Request form (routes/name-tag.js) and every admin-facing
-- surface that reads request_type (routes/admin-name-tag.js,
-- routes/admin-design.js, routes/admin-logs.js, routes/main-admin-name-tags.js).
alter table name_tag_requests drop constraint if exists name_tag_requests_request_type_check;
alter table name_tag_requests add constraint name_tag_requests_request_type_check
  check (request_type in ('lost_tag', 'schedule_change', 'new_tag'));

-- ===== 20260901030000_absence_submission_log.sql =====
-- A real bug report: "If someone submits an absence/late form, it will
-- be over ridden and show a green P for present if they then come in
-- later and check in, it will also show their check in and out time and
-- cleaning team if they did that as well. The log will still record
-- their absence/late form."
--
-- The first half already worked: routes/kiosk.js's own /checkin/scan
-- unconditionally UPSERTs status='present', check_in_time=..., source=
-- 'kiosk' onto the SAME attendance row an earlier absence/late
-- submission wrote (member_id, roster_id, session_date is that row's
-- whole identity), so a real check-in already turns yesterday's "L" or
-- "A" into a real "P" with real times - routes/absence.js's own
-- attendance UPDATE/INSERT is what created that row in the first place.
--
-- The second half didn't: routes/admin-logs.js's Absence/Late tab reads
-- straight off that same live attendance row (WHERE source =
-- 'absence_form'), so the instant the row above gets overwritten to
-- source='kiosk', the original absence/late submission silently
-- disappears from the log too - there was never a separate record of
-- "this form was submitted," only the live, mutable, single-row status.
--
-- This table is that separate, append-only record: one row per
-- Absence/Late form submission, written once by routes/absence.js and
-- never updated or deleted by anything else (in particular, never
-- touched by kiosk check-in), so the Log tab can keep showing it no
-- matter what the live attendance row goes on to become.
create table if not exists absence_submissions (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  roster_id integer not null references rosters(id) on delete cascade,
  session_date text not null,
  status text not null check (status in ('absent', 'late')),
  reason_category text,
  reason_text text,
  submitted_at text not null default now_text()
);
create index if not exists idx_absence_submissions_date on absence_submissions(session_date desc);
create index if not exists idx_absence_submissions_member on absence_submissions(member_id);

-- ===== 20260901040000_forum_category_moderation.sql =====
-- A real request: "main admin portal chat, Moderate tab should have a
-- list of the chat categories. when you click each category it show a
-- pop up of the category's name, description, check box - allow
-- comments, checkboxes - select which section can view or all, dropdown
-- menu to select member to moderate." Three new pieces of per-category
-- settings, alongside the name/description/scope forum_categories
-- already had:
--
-- allow_comments - a category with this off is announcement-only (see
-- routes/forums.js's own reply-form gate); defaults to true so every
-- existing category keeps working exactly as it already does.
--
-- forum_category_sections - same (thing_id, section_id) join-table shape
-- as event_sections/class_sections (see utils/sections.js's own header
-- comment) - "select which section can view or all" - empty means
-- unrestricted, same "empty means unrestricted" convention those two
-- already use, layered ON TOP of the existing scope='class' restriction
-- rather than replacing it.
--
-- moderator_member_id - one member who can moderate THIS category (edit/
-- remove any post, pin/lock/archive threads) without needing the
-- sitewide manage_forum permission a Main Admin/coop_admin role grants -
-- e.g. a parent volunteer moderating a single interest-group chat.
alter table forum_categories add column if not exists allow_comments integer not null default 1;
alter table forum_categories add column if not exists moderator_member_id integer references members(id) on delete set null;

create table if not exists forum_category_sections (
  category_id integer not null references forum_categories(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (category_id, section_id)
);

-- ===== 20260901050000_second_setup_cleanup_badge.sql =====
-- Real request: "after parent scans their setup/cleanup badge it should
-- ask if they have a 2nd setup/cleanup badge to scan, with yes and no
-- buttons. if they select yes, it allows them to scan their barcode...
-- after the 2nd badge entry the screen says thank you! and goes back to
-- the home screen. if they select no, it's says thank you! and goes
-- back to the home screen." A parent covering two Setup/Cleanup jobs the
-- same day is already a modeled case (setup_task_assignments.task_item_id_2,
-- see that migration's own comment - a member routinely covers two jobs
-- at once), so both scan points that record a completed task -
-- attendance (routes/kiosk.js's /checkin/task-scan) and checkouts
-- (routes/checkout.js's /checkout/task-scan) - get a second slot to
-- record a second badge in, mirroring their existing single task_item_id
-- column exactly. attendance.task_scanned_at_2 mirrors task_scanned_at -
-- the "was a 2nd badge actually scanned" signal, distinct from
-- task_item_id_2 being null for a legitimate reason (declined the 2nd
-- badge, or a bypass-badge scan).
alter table attendance add column if not exists task_item_id_2 integer references task_list_items(id) on delete set null;
alter table attendance add column if not exists task_scanned_at_2 bigint;
alter table checkouts add column if not exists task_item_id_2 integer references task_list_items(id) on delete set null;

-- ===== 20260901060000_event_guest_food_sections.sql =====
-- Main Admin Events - a real, large request bundled into one migration:
--
-- "guests can register should only be a check box under who can register
-- with parent and student options" - allow_guest_register joins
-- allow_adult_register/allow_child_register as a third per-event "who
-- can register" toggle (Permissions), independent of the register_guests
-- PORTAL PERMISSION (db/bootstrapPg.js) that already controls whether a
-- given admin is even allowed to add a walk-in guest at all - this is
-- the per-EVENT switch for whether guest registration is offered on
-- this event in the first place.
--
-- "capacity totals dropdown choosing family or person capacity" -
-- collapses the Create/Edit forms' two separate numeric fields
-- (capacity, family_capacity) into one number + a type picker - no
-- schema change needed there, both columns already exist (see
-- routes/admin-events.js's own capacityValue/capacityType handling).
--
-- "on the volunteer, donations and food pages. there will be a check
-- box for, do you want to include this section? then a dropdown menu
-- of numbers 1-50 that ask, how many volunteer/donation/food items
-- should each family/individual registration select" - three parallel
-- (enabled, selection_count) pairs, one per section. *_enabled defaults
-- to 1 (on) for volunteers/donations since those two sections already
-- exist and are already live on every event today - turning this
-- migration on must not silently hide a section admins are already
-- using. food_enabled defaults to 0 since Food is a brand new section
-- nothing has opted into yet. *_selection_count is nullable (no stored
-- minimum) until an admin actually sets one from the dropdown.
alter table events add column if not exists allow_guest_register integer not null default 0;
alter table events add column if not exists volunteers_enabled integer not null default 1;
alter table events add column if not exists donations_enabled integer not null default 1;
alter table events add column if not exists food_enabled integer not null default 0;
alter table events add column if not exists volunteer_selection_count integer;
alter table events add column if not exists donation_selection_count integer;
alter table events add column if not exists food_selection_count integer;

-- Food items - a brand new third section alongside the existing
-- Volunteer Roles/Donation Items, same shape as event_donation_items/
-- event_donation_claims exactly (a potluck-style "bring an item" sign-up
-- sheet, claimed by members the same way a donation item already is).
create table if not exists event_food_items (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  deadline text,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_food_items_event on event_food_items(event_id);

create table if not exists event_food_claims (
  id integer generated always as identity primary key,
  food_item_id integer not null references event_food_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_event_food_claims_item on event_food_claims(food_item_id);

alter table public.event_food_items enable row level security;
alter table public.event_food_claims enable row level security;

-- ===== 20260918010000_committees_and_signup_lists.sql =====
-- A real request: "main admin portal, volunteer tab, sub pages
-- committees, sign up list, volunteer list." Three separate features,
-- each modeled after the shapes utils/events.js's own volunteer roles/
-- donation items already established for the exact same "a list of
-- slots, members claim one" pattern:
--   - committees: a standing (not per-event) group with named positions
--     members can sign up to help with, same role_name/slots_needed
--     shape as event_volunteer_roles/event_volunteer_signups.
--   - sign_up_lists: "a list of things for people to sign up for" - same
--     item_name/quantity_needed/claim shape as event_donation_items/
--     event_donation_claims.
--   - volunteer_signup_lists: "a list of jobs by date or hour that
--     members can sign up for" - its own shift_date/start_time/end_time
--     per slot, the one genuinely new shape here. Named
--     volunteer_signup_lists rather than volunteer_lists - see that
--     table's own comment below for why.
-- sign_up_lists/volunteer_signup_lists' own event_id is nullable ("be
-- able to attach these lists to events") - null means a standalone list
-- not tied to any one event, same "optional FK, null means unattached"
-- convention events.js's own category_id/location_id already use.

create table if not exists committees (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  leader_name text,
  contact_info text,
  enabled integer not null default 1,
  created_at text not null default now_text()
);

create table if not exists committee_positions (
  id integer generated always as identity primary key,
  committee_id integer not null references committees(id) on delete cascade,
  position_name text not null,
  slots_needed integer,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_committee_positions_committee on committee_positions(committee_id);

create table if not exists committee_signups (
  id integer generated always as identity primary key,
  position_id integer not null references committee_positions(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (position_id, member_id)
);
create index if not exists idx_committee_signups_position on committee_signups(position_id);
create index if not exists idx_committee_signups_member on committee_signups(member_id);

create table if not exists sign_up_lists (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  event_id integer references events(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_lists_event on sign_up_lists(event_id);

create table if not exists sign_up_list_items (
  id integer generated always as identity primary key,
  list_id integer not null references sign_up_lists(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_list_items_list on sign_up_list_items(list_id);

create table if not exists sign_up_list_claims (
  id integer generated always as identity primary key,
  item_id integer not null references sign_up_list_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_list_claims_item on sign_up_list_claims(item_id);

-- Named volunteer_signup_lists, not volunteer_lists - that name is
-- already a real, unrelated table (the pre-existing Floater Assignments
-- feature's own day-based roster, supabase/migrations/
-- 20260811035644_initial_schema.sql). Same idea as sign_up_lists above
-- (an optional event_id), just with dated/timed shifts instead of items.
create table if not exists volunteer_signup_lists (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  event_id integer references events(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_volunteer_signup_lists_event on volunteer_signup_lists(event_id);

create table if not exists volunteer_signup_list_shifts (
  id integer generated always as identity primary key,
  list_id integer not null references volunteer_signup_lists(id) on delete cascade,
  job_name text not null,
  shift_date text,
  start_time text,
  end_time text,
  slots_needed integer not null default 1,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_volunteer_signup_list_shifts_list on volunteer_signup_list_shifts(list_id);

create table if not exists volunteer_signup_list_signups (
  id integer generated always as identity primary key,
  shift_id integer not null references volunteer_signup_list_shifts(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (shift_id, member_id)
);
create index if not exists idx_volunteer_signup_list_signups_shift on volunteer_signup_list_signups(shift_id);
create index if not exists idx_volunteer_signup_list_signups_member on volunteer_signup_list_signups(member_id);

-- ===== 20260918020000_roster_manual_removals.sql =====
-- Real bug report: "Monday/Wednesday attendance. If someone is manually
-- deleted from the roster they are not automatically added back unless
-- their schedule changes." Before this, POST /admin/rosters/:tab/remove-
-- member/:memberId (routes/admin-rosters.js) just deleted the
-- roster_members row outright, with nothing remembering that removal was
-- deliberate - the next syncDayMemberRosters() run (triggered by ANY
-- other class's enrollment/staffing change that same day, not just this
-- member's own) recomputed the day's expected membership from scratch and
-- silently re-added them, since they were often still enrolled/staffed
-- exactly as before. This table is that memory: a row here means "an
-- admin explicitly removed this member from this roster - don't let a
-- routine resync put them back," cleared only when utils/classSchedule.js's
-- setEnrollment/addStaff record a genuine schedule change for that same
-- member (see those functions' own updated comments).
create table if not exists roster_manual_removals (
  roster_id integer not null references rosters(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  removed_at text not null default now_text(),
  primary key (roster_id, member_id)
);

-- ===== 20260918030000_store_categories_and_sizes.sql =====
-- Real request: "do the admin shop features" - product categories (for
-- the Shop's own category filter and a Settings tab to manage them,
-- same admin-managed add/rename/delete shape as classified_categories)
-- plus per-product sizes: a comma-separated list of size labels a buyer
-- picks one of at checkout (e.g. a co-op hoodie's "S,M,L,XL"). Null sizes
-- means the product has none to choose from - same "opt-in" shape as
-- inventory_count's own null-means-unlimited.
create table if not exists store_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default now_text()
);

alter table store_products add column if not exists category_id integer references store_categories(id) on delete set null;
alter table store_products add column if not exists sizes text;
create index if not exists idx_store_products_category on store_products(category_id);

-- A snapshot of the size the buyer picked, same reasoning as
-- unit_price_cents right above it in the original store migration - a
-- later change to a product's available sizes must never retroactively
-- change what a past order shows as bought. Null for a product with no
-- sizes.
alter table store_order_items add column if not exists size text;

-- ===== 20260919000000_committee_members_and_leader.sql =====
-- A real request: "adding a leader should be a drop down list of admin
-- positions. Choose an admin and the leaders name and email address
-- appears below," with a single leader per committee (not the existing
-- committee_positions/committee_signups shape, which is many-per-slot and
-- self-service). leader_member_id points straight at the chosen person
-- (resolved from whichever admin_positions they hold, at pick time) -
-- simpler than storing which position they were picked under, since all
-- the form ever needs afterward is that one member's own name/email.
-- leader_name/contact_info (the old free-text fields) stay untouched for
-- any committee created before this migration; the form just stops
-- offering them going forward.
alter table committees add column if not exists leader_member_id integer references members(id) on delete set null;

-- A real, separate request from the same conversation: "add a member
-- button" - a plain roster of people on a committee, independent of
-- committee_positions/committee_signups (that pair models a specific
-- named role with a slot count and self-service sign-up via a portal
-- account; this is just "this person is on this committee," added
-- directly by Main Admin, no slot or self-service involved).
create table if not exists committee_members (
  id integer generated always as identity primary key,
  committee_id integer not null references committees(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  created_at text not null default now_text(),
  unique (committee_id, member_id)
);
create index if not exists idx_committee_members_committee on committee_members(committee_id);
create index if not exists idx_committee_members_member on committee_members(member_id);

-- ===== 20260920010000_event_cancelled_notification_type.sql =====
-- A real request: "cancel event... automatic email will be sent to
-- anyone registered for the event to let them know the event is
-- canceled." Registrants are notified through the same notify()
-- entry point every other feature uses (see 20260825110000_notifications.sql),
-- which requires the type to exist in this catalog first.
insert into notification_types (key, label, description) values
  ('event_cancelled', 'Event Cancelled', 'An event you were registered for was cancelled.')
on conflict (key) do nothing;

-- ===== 20260920020000_event_settings_auto_refund.sql =====
-- A real request: "new settings, automatically issue refund if member
-- cancels their registration" - a new Main Admin > Events > Settings
-- toggle, same "stored, ready to wire up once a real refund/payment
-- system exists" shape as credit_on_family_cancel/credit_on_admin_cancel
-- next to it (see 20260829010000_event_settings.sql's own header
-- comment).
alter table event_settings add column if not exists auto_refund_on_family_cancel integer not null default 0;

-- ===== 20260920030000_forum_category_archive_and_subscribers.sql =====
-- A real request: "lock the chat group should be under edit, not on the
-- front of the chat group card. There should also be an archive
-- button." Reuses forum_threads' own 'active'/'archived' status
-- convention (this table's own sibling already has it, see
-- 20260825060000_forums.sql) instead of a new one-off boolean.
alter table forum_categories add column if not exists status text not null default 'active' check (status in ('active', 'archived'));

-- A real request: "edit chat group... should also show a full list of
-- all members... a column next to each name with checkboxes that is
-- called email notifications. Checking the boxes says they will receive
-- notifications." A row's presence is the "on" state - nobody is
-- subscribed by default, since no such per-chat-group list exists for
-- anyone to have opted into yet (the inverse of notification_preferences'
-- own "only store what deviates from a default-on baseline" shape - this
-- one's baseline is off).
create table if not exists forum_category_subscribers (
  id integer generated always as identity primary key,
  category_id integer not null references forum_categories(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  created_at text not null default now_text(),
  unique (category_id, member_id)
);
create index if not exists idx_forum_category_subscribers_category on forum_category_subscribers(category_id);

-- ===== 20260921010000_store_product_options.sql =====
-- A real request: "Store, adding options to a product should be a row
-- with a bar for the option title and the individual price next to it,
-- and box for qty and enable/disable button." Replaces the old plain
-- comma-separated store_products.sizes text (no per-size price or
-- stock) with a real per-option row: its own price (not a delta off the
-- product's base price - some options are simply priced differently),
-- its own stock count (same null-means-unlimited shape as store_products.
-- inventory_count), and its own enabled flag (a temporarily-unavailable
-- option stays on the product instead of being deleted and losing its
-- history). store_products.sizes/store_order_items.size are left in
-- place, untouched, so every pre-existing order still displays exactly
-- what it always did - only new code stops reading/writing them.
create table if not exists store_product_options (
  id integer generated always as identity primary key,
  product_id integer not null references store_products(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  quantity integer,
  enabled integer not null default 1,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_store_product_options_product on store_product_options(product_id);

-- No automatic backfill from the old sizes text - a size never carried
-- its own price or stock, so there's nothing to carry over beyond the
-- label itself. views/admin-store-edit.ejs shows any pre-existing sizes
-- as a plain read-only hint (only while a product has no options yet) so
-- an admin who already set them up notices and re-enters them as real
-- options instead of losing them silently.

-- order_id kept snapshot-first, same reasoning as store_order_items'
-- existing unit_price_cents/size columns: option_id is nullable (a later
-- edit to a product's own options list clears and re-inserts every row,
-- see utils/store.js's own setProductOptions - a past order must never
-- point at a since-replaced row) while option_name is a permanent text
-- snapshot of whichever option was actually chosen.
alter table store_order_items add column if not exists option_id integer references store_product_options(id) on delete set null;
alter table store_order_items add column if not exists option_name text;

-- ===== 20260922010000_event_settings_tab_redesign.sql =====
-- A real request: "event setting check boxes or yes/no in a column on
-- the left, question to the right. questions with check boxes is this a
-- public event, allow refunds when member cancels registration, close
-- event, allow registration cancelations, allow members to register
-- guests, allow other members to see who is registered for the event,
-- only track participants. grade level multiple choice, age multiple
-- choice check boxes next to both that say lock registration to age
-- level or lock registration to grade level. checkbox lock registration
-- to section, drop down of sections. lock registration to only be
-- viewable to one section check box and dropdown." "Is this a public
-- event" and "allow members to register guests" reuse the existing
-- visibility/allow_guest_register columns (just relocated in the UI from
-- the Details/"Who Can Register" sections into this new list); the rest
-- are new. close_event/allow_registration_cancellations gain real
-- enforcement in utils/events.js's registerForEvent/cancelRegistration;
-- allow_refund_on_cancel/show_registrants_to_members/
-- track_participants_only are stored, ready to wire up once a real
-- refund or "who else is registered" feature exists in this app, same
-- "controls X once a real feature exists" pattern event_settings'
-- several fields already use (20260829010000_event_settings.sql).
alter table events add column if not exists is_closed integer not null default 0;
alter table events add column if not exists allow_registration_cancellations integer not null default 1;
alter table events add column if not exists allow_refund_on_cancel integer not null default 0;
alter table events add column if not exists show_registrants_to_members integer not null default 0;
alter table events add column if not exists track_participants_only integer not null default 0;

-- The existing age_group column already restricts by grade whenever it
-- has values ("empty means unrestricted"); this adds an explicit on/off
-- switch instead of relying on "did anyone check a grade box" alone, per
-- the "lock registration to grade level" checkbox asked for above. A new
-- parallel age-bucket restriction (age_group_restriction, using the same
-- AGE_GROUPS keys utils/emailComposer.js already buckets members into
-- for Communication filtering) gets the same kind of lock.
alter table events add column if not exists lock_registration_to_grade integer not null default 0;
alter table events add column if not exists lock_registration_to_age integer not null default 0;
alter table events add column if not exists age_group_restriction text;

-- Single-section locks, distinct from the existing many-section
-- event_sections restriction (20260826040000_events_registration_rules.sql,
-- which already restricts BOTH viewing and registering to any of several
-- sections) - these are additional, narrower single-section gates: one
-- for registering, one for who can even see the event. Both combine with
-- any existing event_sections restriction (a member must satisfy every
-- restriction that applies, not just one), rather than replacing it.
alter table events add column if not exists lock_registration_to_section integer not null default 0;
alter table events add column if not exists registration_section_id integer references sections(id) on delete set null;
alter table events add column if not exists lock_visibility_to_section integer not null default 0;
alter table events add column if not exists visibility_section_id integer references sections(id) on delete set null;

-- ===== 20260923010000_class_photo.sql =====
-- A real request: "sql editor copy paste should be for event photo,
-- class photo and shop photo" - events (image_key, 20260825030000) and
-- store products (image_key, store migrations) already had a photo;
-- classes didn't. Same "one optional image per record" shape as those.
alter table classes add column if not exists image_key text;

-- ===== 20260923020000_signup_volunteer_list_member.sql =====
-- A real request: "main admin signup lists and volunteer lists, edit...
-- below attach to event, there should be a drop down for attach to
-- member with a choice of members listed abc by last name." Same
-- optional "attach to one of these, or none" shape event_id already has
-- on both tables - nullable, null means unattached.
alter table sign_up_lists add column if not exists member_id integer references members(id) on delete set null;
alter table volunteer_signup_lists add column if not exists member_id integer references members(id) on delete set null;

-- ===== 20260924010000_event_ticket_types_and_accounting_category.sql =====
-- A real request: "event settings, finance, if charging per person there
-- should be an option for adding several types of tickets with a
-- different price and title bar next to it. Add a drop down menu for
-- choosing accounting category." Admin-side only for now (a scoping
-- question confirmed this) - registration still charges the event's own
-- flat price_cents; wiring an actual ticket-type CHOICE into registration
-- and charging is a separate follow-up.

-- One event can offer several named price tiers ("Adult", "Child",
-- "VIP", ...) once it's charging per person - same has-many-rows-owned-
-- by-one-event shape as event_volunteer_roles/event_donation_items/
-- event_food_items (cascade-deleted with the event, no separate
-- "enabled" toggle needed since an empty list already means "no ticket
-- types defined").
create table if not exists event_ticket_types (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  title text not null,
  price_cents integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_ticket_types_event on event_ticket_types(event_id);

-- Main-Admin-managed, same shape/reasoning as event_categories (see
-- 20260826040000_events_registration_rules.sql) - a fixed list an event
-- picks one of, for internal bookkeeping rather than the public-facing
-- Category dropdown (Social/Fundraiser/etc.) events already have.
create table if not exists event_accounting_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists accounting_category_id integer references event_accounting_categories(id) on delete set null;

-- ===== 20260925010000_event_extra_fields.sql =====
-- A real request: "volunteers, food, donations and extra fields tabs
-- should be under one tab called, Volunteers... Extra fields is where
-- you can add extra form type questions for people signing up for an
-- event." A per-event custom question (text/textarea/select/checkbox),
-- answered once per registration - see utils/events.js's own comment on
-- why this is separate from the existing standalone Custom Forms feature.

create table if not exists event_extra_fields (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  label text not null,
  field_type text not null default 'text' check (field_type in ('text', 'textarea', 'select', 'checkbox')),
  options text,
  required integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_extra_fields_event on event_extra_fields(event_id);

create table if not exists event_registration_answers (
  id integer generated always as identity primary key,
  registration_id integer not null references event_registrations(id) on delete cascade,
  extra_field_id integer not null references event_extra_fields(id) on delete cascade,
  value text,
  created_at text not null default now_text(),
  unique (registration_id, extra_field_id)
);
create index if not exists idx_event_registration_answers_registration on event_registration_answers(registration_id);

-- ===== 20260926010000_event_ticket_type_price_per.sql =====
-- A real request: "event settings finance, add ticket types, price,
-- title and permissions person or family" - each ticket type now carries
-- its own person/family charge basis instead of relying on the event's
-- own (now hidden from the Finance tab) flat price_per.

alter table event_ticket_types add column if not exists price_per text not null default 'person' check (price_per in ('person', 'family'));

-- ===== 20260927010000_event_settings_registration_group.sql =====
-- A real request: reorganizing the Settings tab's checkbox list into
-- "Registration Settings" and "General Settings" sections surfaced two
-- new questions among the reworded set: "Allow waiting list signups
-- (only applicable when Max Allowed is reached)" and "Allow registrants
-- to 'Sign Up For' on behalf of other families in your group."
--
-- allow_waitlist_signups defaults to 1 (true) to preserve every existing
-- event's current behavior (a full event has always waitlisted rather
-- than rejecting) - this is wired for real in utils/events.js's
-- createOrReactivateRegistration (registerForEvent's own member-facing
-- call passes the event's own value; adminAddRegistrations keeps
-- bypassing it, same as it already bypasses every other member-facing
-- registration rule).
--
-- allow_signup_for_others_in_group is stored only for now, ready to wire
-- up once a real "register another family in the co-op" member-facing
-- feature exists - same pattern allow_refund_on_cancel/
-- show_registrants_to_members/track_participants_only already use.
alter table events add column if not exists allow_waitlist_signups integer not null default 1;
alter table events add column if not exists allow_signup_for_others_in_group integer not null default 0;

-- ===== 20260928010000_event_payment_instructions.sql =====
alter table events add column if not exists payment_instructions_title text;
alter table events add column if not exists payment_instructions_text text;

-- ===== 20260929010000_registration_windows_day_section.sql =====
-- A real request: "main admin, classes, settings. Add registration
-- schedule. Be able to control who can signup on each schedule grid
-- monday/wednesday. Date, time and section and open for teacher or
-- assistant registration." A follow-up question confirmed this should
-- gate everyone who registers for a class (parents/students/teachers),
-- not just teacher/assistant - role_key already covers that. Day and
-- section narrow an existing registration_windows row to one schedule
-- grid / one Sections group, same "column present but null means
-- unrestricted" convention role_key already uses - a co-op with no
-- windows, or a window that leaves these blank, sees no behavior change.
alter table registration_windows add column if not exists day text check (day in ('monday', 'wednesday'));
alter table registration_windows add column if not exists section_id integer references sections(id) on delete set null;
create index if not exists idx_registration_windows_section on registration_windows(section_id);

-- ===== 20260930010000_class_chat_messages.sql =====
-- A real request: "classes tabs, add class chat" - a simple message log
-- scoped to one class, for Co-op Admin's own legacy admin session (a
-- follow-up question confirmed: a separate, simple board here rather
-- than reusing the existing Main Admin/portal forums feature, which
-- lives entirely under a different login this page's own admin session
-- doesn't carry). No threads/moderation/sections - just a flat,
-- chronological log, same "cascade-deleted with the class" convention
-- every other classes_id-owned table already uses.
create table if not exists class_chat_messages (
  id integer generated always as identity primary key,
  class_id integer not null references classes(id) on delete cascade,
  admin_username text not null,
  body text not null,
  created_at text not null default now_text()
);
create index if not exists idx_class_chat_messages_class on class_chat_messages(class_id, created_at);

-- ===== 20260930020000_class_age_selection.sql =====
-- A real request: "co-op admin portal, classes, grade selection and age
-- selection should be separate menus of choices." classes.age_group
-- stayed the Grade list (GRADE_LEVELS - Infant through 12th, unchanged);
-- this adds a second, independent comma-joined list of exact numeric
-- ages (0-100), same shape utils/events.js's own AGE_OPTIONS restriction
-- already uses for events - "deliberately its own list," not a grade
-- vocabulary. Both empty means unrestricted, same convention age_group
-- already used alone.
alter table classes add column if not exists numeric_ages text;

-- ===== 20261001010000_lesson_content_and_quizzes.sql =====
-- A real request: "Classes, lessons. Button to add lessons. Could be
-- link to video, text description, file link, quiz with scoring. Setup
-- as lesson title with drop down of the different links and activities.
-- Be able to reorder, assignments or lessons, drag and drop, due dates,
-- open dates, Co-op admin and teacher dashboard have controls. Parent
-- and student portal can view the classes and interact." Follow-up
-- questions confirmed: quizzes mix multiple-choice (auto-scored) and
-- short-answer (teacher/admin reviews before the score is final), and
-- quiz-taking is student-only (parent can view, never submit).
--
-- class_assignments IS "lessons" now (renamed in the UI a task ago,
-- table name kept - see that migration's own comment on why nothing
-- here is a parallel table). open_date/position are new; everything
-- else about the lesson itself is unchanged.
alter table class_assignments add column if not exists open_date text;
alter table class_assignments add column if not exists position integer;
-- Backfill: every existing lesson gets a position ordered by its old
-- default sort (due date, then newest first) so drag-reorder has a
-- stable starting order instead of every row tying at NULL.
with ordered as (
  select id, row_number() over (partition by class_id order by due_date is null, due_date desc, created_at desc) as rn
  from class_assignments
)
update class_assignments c set position = ordered.rn from ordered where ordered.id = c.id and c.position is null;

-- One lesson can carry several content blocks - a video link, a text
-- description, a file link, and/or a quiz - each its own row so a
-- lesson isn't limited to one of each, and so reordering blocks within
-- a lesson (drag and drop) doesn't need to touch class_assignments
-- itself.
create table if not exists lesson_content_items (
  id integer generated always as identity primary key,
  assignment_id integer not null references class_assignments(id) on delete cascade,
  type text not null check (type in ('video', 'text', 'file', 'quiz')),
  position integer not null default 0,
  title text,
  video_url text,
  body text,
  file_url text,
  created_at text not null default now_text()
);
create index if not exists idx_lesson_content_items_assignment on lesson_content_items(assignment_id);

-- A quiz content item's own questions - multiple_choice (auto-scored
-- against quiz_choices.is_correct) or short_answer (free text, scored
-- by hand - see quiz_answers.points_earned staying null until a
-- teacher/admin reviews it).
create table if not exists quiz_questions (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  type text not null check (type in ('multiple_choice', 'short_answer')),
  prompt text not null,
  points_possible numeric not null default 1,
  position integer not null default 0
);
create index if not exists idx_quiz_questions_content_item on quiz_questions(content_item_id);

-- Only meaningful for a multiple_choice question - a short_answer
-- question has no rows here at all.
create table if not exists quiz_choices (
  id integer generated always as identity primary key,
  question_id integer not null references quiz_questions(id) on delete cascade,
  label text not null,
  is_correct integer not null default 0,
  position integer not null default 0
);
create index if not exists idx_quiz_choices_question on quiz_choices(question_id);

-- One row per student per quiz (single-attempt, same "no history, just
-- the current state" shape assignment_grades already uses) - status
-- stays 'pending_review' as long as ANY of this attempt's short_answer
-- answers hasn't been scored yet, flips to 'graded' (and score_points
-- gets its final total) the moment every one of them has. A pure-
-- multiple-choice quiz is 'graded' immediately at submission.
create table if not exists quiz_attempts (
  id integer generated always as identity primary key,
  content_item_id integer not null references lesson_content_items(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  status text not null default 'pending_review' check (status in ('pending_review', 'graded')),
  score_points numeric,
  points_possible numeric not null,
  submitted_at text not null default now_text(),
  graded_at text,
  graded_by_account_id integer references member_accounts(id) on delete set null,
  unique (content_item_id, student_id)
);
create index if not exists idx_quiz_attempts_student on quiz_attempts(student_id);

-- What the student actually answered, one row per question in their
-- attempt. choice_id is set for a multiple_choice answer (and
-- is_correct/points_earned are filled in immediately, auto-scored
-- against quiz_choices); answer_text is set for a short_answer one
-- (is_correct/points_earned stay null until reviewed).
create table if not exists quiz_answers (
  id integer generated always as identity primary key,
  attempt_id integer not null references quiz_attempts(id) on delete cascade,
  question_id integer not null references quiz_questions(id) on delete cascade,
  choice_id integer references quiz_choices(id) on delete set null,
  answer_text text,
  is_correct integer,
  points_earned numeric,
  unique (attempt_id, question_id)
);
create index if not exists idx_quiz_answers_attempt on quiz_answers(attempt_id);

-- ===== 20261002010000_class_parent_lesson_chat_permissions.sql =====
-- A real request: "Add to class settings, check boxes, allow parents to
-- complete lessons for student and allow parent to interact in the class
-- chat. This way it can be turned on or off for different classes." Both
-- default OFF, same as this app's other opt-in-per-class toggles
-- (allow_student_register, auto_refund_on_cancel) - a class only grants
-- either permission once an admin deliberately flips it on, on the
-- existing Schedules > Settings tab (utils/classSchedule.js's own
-- CLASS_SETTINGS_FIELDS/updateClassSettings).
alter table classes add column if not exists allow_parent_complete_lessons integer not null default 0;
alter table classes add column if not exists allow_parent_chat integer not null default 0;

-- class_chat_messages (the Class Dashboard's own "Chat" tab) was admin-
-- only when it was built, hence admin_username - now that allow_parent_chat
-- above can let a parent post here too, that column name would be actively
-- misleading (it'd hold a parent's own name, not an admin's). Renaming
-- rather than adding a second column: every existing row is still exactly
-- "whoever posted this message's display name", just not exclusively an
-- admin's anymore.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'class_chat_messages' and column_name = 'admin_username'
  ) then
    alter table class_chat_messages rename column admin_username to author_name;
  end if;
end $$;

-- ===== 20261003010000_orientation_progress.sql =====
-- A real request: "Co-op admin portal. Add an orientation tab. List of
-- members registered for classes on either day. Columns, member name,
-- day Monday/Wednesday, orientation video, orientation meet up, teacher
-- training and tour. The last four are circle check boxes that show
-- green when complete. When they check in for the tour, check in for
-- orientation meet up, complete the parent orientation video and teacher
-- orientation video. Percentage to complete at the end of the row.
-- Subpages, tour check in, orientation check in."
--
-- One row per (primary parent, day) pair - orientation/tour/teacher
-- training is a family-level obligation tied to whichever day(s) that
-- family has a student enrolled in classes, not a per-student one (two
-- siblings enrolled in the same day's classes share one row - see
-- utils/orientation.js's own comment on why it's keyed off the primary
-- parent, reusing the same primaryParentsFor lookup Schedule Cards
-- already use). member_id intentionally has no foreign key ON DELETE
-- CASCADE tie to a specific class or enrollment - this table outlives
-- any one term's roster, same as student_academic_history's own reasoning.
create table if not exists orientation_progress (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  day text not null check (day in ('monday', 'wednesday')),
  video_complete integer not null default 0,
  video_completed_at text,
  meetup_complete integer not null default 0,
  meetup_completed_at text,
  teacher_training_complete integer not null default 0,
  teacher_training_completed_at text,
  tour_complete integer not null default 0,
  tour_completed_at text,
  unique (member_id, day)
);
create index if not exists idx_orientation_progress_member on orientation_progress(member_id);
