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
