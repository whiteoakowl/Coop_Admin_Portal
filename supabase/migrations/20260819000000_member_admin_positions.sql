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
