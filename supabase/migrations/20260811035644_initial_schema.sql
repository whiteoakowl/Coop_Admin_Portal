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
  number integer check (number is null or number between 1 and 80),
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
  position integer not null default 0
);
create index if not exists idx_task_list_items_section on task_list_items(section_id);

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
  created_at text not null default now_text()
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
