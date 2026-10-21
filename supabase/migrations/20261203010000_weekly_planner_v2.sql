-- A real follow-up request completely redesigns the Weekly Planner:
-- "Add week button. Popup allows you to choose up to 7 dates. And add
-- a title such as week 1, week 2 etc. Create and cancel buttons. Then
-- it creates a grid with those dates. Add an assignment button. Pop up
-- allows you to write subject, title of assignment or dropdown to
-- choose an assignment from family management assignments from parent
-- created classes. Save, cancel. Buttons. Print should show the whole
-- week on one page clean... Weekly plan should allow you to make a
-- different weekly plan for each student, parent weekly plan and
-- family weekly plan."
--
-- This replaces family_school_weekly_plans/_columns/_rows/_cells
-- (20261124010000_family_school_planner.sql) - that design was always
-- exactly ONE implicit, Mon-anchored grid per student per real calendar
-- week; this one is explicitly created, named "weeks" built from up to
-- 7 freely CHOSEN dates (not necessarily a real calendar week), and can
-- belong to one specific student, the parent, or the whole family
-- rather than always being per-student. The old tables are left in
-- place rather than dropped - this feature was built and is being
-- redesigned in the same working session, so there's no real production
-- data to migrate, but dropping tables on a live site's database is
-- not something to do without being asked.
create table if not exists family_school_weeks (
  id integer generated always as identity primary key,
  family_id integer not null references families(id) on delete cascade,
  owner_type text not null check (owner_type in ('student', 'parent', 'family')),
  -- Only ever set (and only ever meaningful) when owner_type = 'student' -
  -- the same "null means this isn't that kind of row" shape family_school_
  -- content_items' own per-type nullable columns (video_url, file_url,
  -- etc.) already use rather than three separate owner tables.
  student_id integer references members(id) on delete cascade,
  title text not null,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_family_school_weeks_family on family_school_weeks(family_id);
create index if not exists idx_family_school_weeks_student on family_school_weeks(student_id);

-- Up to 7 explicitly chosen dates per week (enforced in app code, not a
-- hard DB constraint - the Family Attendance calendar's own month grid
-- is the only other date-heavy UI in this app, and that one's a real
-- calendar grid, not a free pick list, so there's no existing DB-level
-- precedent to match here). position preserves the order they were
-- picked in, not necessarily chronological.
create table if not exists family_school_week_dates (
  id integer generated always as identity primary key,
  week_id integer not null references family_school_weeks(id) on delete cascade,
  date text not null,
  position integer not null default 0,
  unique (week_id, date)
);
create index if not exists idx_family_school_week_dates_week on family_school_week_dates(week_id);

-- "Write subject, title of assignment or dropdown to choose an
-- assignment from family management assignments from parent created
-- classes." content_item_id is set only when the dropdown picked a real
-- assignment (family_school_content_items, type 'assignment_upload' or
-- 'assignment_submission') - subject/title are always stored directly
-- either way (copied from the content item when one was picked) so this
-- row never has to join back to that table just to render the grid, and
-- still reads fine if that content item is later deleted (on delete set
-- null, not cascade - the planner entry itself is real, independent
-- work a parent wrote down, not a view of the assignment).
create table if not exists family_school_week_assignments (
  id integer generated always as identity primary key,
  week_date_id integer not null references family_school_week_dates(id) on delete cascade,
  subject text,
  title text not null,
  content_item_id integer references family_school_content_items(id) on delete set null,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_family_school_week_assignments_date on family_school_week_assignments(week_date_id);
