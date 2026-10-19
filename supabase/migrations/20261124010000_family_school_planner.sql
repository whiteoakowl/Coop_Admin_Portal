-- Family School Management - Annual Planner and Schedule Planner
-- subpages. Originally one combined "Planner" page with an Annual Plan
-- tab (a plain dated list) and a Weekly Plan tab (a per-week grid) - a
-- later real request split these into their own named subpages and
-- redefined Annual Plan's own shape entirely: "Family management
-- should also have a subpage called annual planner where it is
-- organized by student and you add curriculum under each student. Pop
-- up asks for curriculum name, brand, level and price," and "The other
-- new planner page under family school management should be called
-- schedule planner." family_school_curriculum_items replaces the old
-- (never-shipped, dated-entry) family_school_annual_plan_entries below;
-- the Schedule Planner's own weekly-grid tables are otherwise unchanged
-- from the original Planner design - same "nothing to do with co-op
-- classes" standalone scope as the rest of family_school_*
-- (20261123010000_family_school_management.sql's own header comment).

-- Annual Planner - "organized by student and you add curriculum under
-- each student. Pop up asks for curriculum name, brand, level and
-- price." One row per curriculum item; price is numeric (not integer
-- cents) to match how every other free-entry dollar amount in this app
-- already stores (e.g. family_school_content_items.points_possible's
-- own numeric sibling fields elsewhere), not a currency subsystem of
-- its own.
create table if not exists family_school_curriculum_items (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  name text not null,
  brand text,
  level text,
  price numeric,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_family_school_curriculum_items_student on family_school_curriculum_items(student_id);

-- Schedule Planner - "View weekly plan grid for each student" - a real
-- decision (asked and confirmed): scoped to one specific calendar week
-- per student, with Prev/Next navigation, the same shape family_school_
-- attendance already uses for "one calendar unit per student, stepped
-- through over time" - not one single reusable template. week_start_date
-- is always that week's own Monday (ISO date) - the grid's own
-- navigation key.
create table if not exists family_school_weekly_plans (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  week_start_date text not null,
  created_at text not null default now_text(),
  updated_at text not null default now_text(),
  unique (student_id, week_start_date)
);
create index if not exists idx_family_school_weekly_plans_student on family_school_weekly_plans(student_id);

-- "Be able to add rows and columns to create plan grid for the week" -
-- a fully custom spreadsheet, not a fixed Mon-Sun table: columns/rows
-- are their own ordered, labeled rows a parent can add to (and delete
-- from) freely, same "position" ordering convention family_school_lessons/
-- family_school_content_items already use. A brand new plan is seeded
-- with one column per actual day of that week (utils/familySchool.js's
-- own getOrCreateWeeklyPlan) as a sensible starting point, not a
-- hardcoded part of this schema - a parent can still delete/add past
-- that starting point.
create table if not exists family_school_weekly_plan_columns (
  id integer generated always as identity primary key,
  plan_id integer not null references family_school_weekly_plans(id) on delete cascade,
  label text not null,
  position integer not null default 0
);
create index if not exists idx_family_school_weekly_plan_columns_plan on family_school_weekly_plan_columns(plan_id);

create table if not exists family_school_weekly_plan_rows (
  id integer generated always as identity primary key,
  plan_id integer not null references family_school_weekly_plans(id) on delete cascade,
  label text not null,
  position integer not null default 0
);
create index if not exists idx_family_school_weekly_plan_rows_plan on family_school_weekly_plan_rows(plan_id);

-- One cell per row/column intersection - a row added before any columns
-- exist (or vice versa) simply has no cells yet at any of those
-- intersections, same "no row at all is the real empty state" shape
-- family_school_attendance's own unmarked days already use, rather than
-- a cell row for every possible pairing up front.
create table if not exists family_school_weekly_plan_cells (
  id integer generated always as identity primary key,
  row_id integer not null references family_school_weekly_plan_rows(id) on delete cascade,
  column_id integer not null references family_school_weekly_plan_columns(id) on delete cascade,
  content text,
  updated_at text not null default now_text(),
  unique (row_id, column_id)
);
create index if not exists idx_family_school_weekly_plan_cells_row on family_school_weekly_plan_cells(row_id);
create index if not exists idx_family_school_weekly_plan_cells_column on family_school_weekly_plan_cells(column_id);
