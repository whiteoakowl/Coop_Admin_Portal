-- Real request: "Print setup/cleanup badges. Add a filter button. Filter
-- popup included dropdown to select team and dropdown to select semester
-- or all." Each setupCleanup misc_badges row already denormalizes its
-- team name/day/leader onto itself (see the migration that added
-- day/leader_name - "Setup/cleanup task cards are a mess" - and
-- utils/taskList.js's upsertTaskBadge) so the print panel's checklist
-- never has to join back to task_list_items/task_list_sections just to
-- show them. Filtering by team and semester needs the same thing: a
-- stable id to filter on, not the team's display name/day text, so these
-- two nullable columns join the existing pair, kept in sync the exact
-- same way (upsertTaskBadge, called from badgeContextForSection's own
-- callers whenever a task item is created/updated or a team's badges are
-- refreshed).
alter table misc_badges add column if not exists team_id integer references setup_teams(id) on delete set null;
alter table misc_badges add column if not exists semester_id integer references semesters(id) on delete set null;

-- One-time backfill for every setupCleanup badge that already exists -
-- day/leader_name above had no backfill (self-healing was good enough for
-- two display-only fields), but the Team/Semester filter needs to work
-- immediately on today's existing badges too, not wait for every task
-- item to be touched once before it shows up correctly filtered.
update misc_badges mb
set team_id = tls.team_id,
    semester_id = tls.semester_id
from task_list_items tli
join task_list_sections tls on tls.id = tli.section_id
where mb.task_item_id = tli.id
  and mb.badge_type = 'setupCleanup';
