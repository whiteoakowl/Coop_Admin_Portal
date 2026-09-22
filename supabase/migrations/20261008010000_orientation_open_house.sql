-- A real request: "Co-op admin portal, orientation member list...
-- add a column for open house." Same shape as the 4 existing circle
-- columns on orientation_progress (one _complete/_completed_at pair per
-- column - see 20261003010000_orientation_progress.sql).
alter table orientation_progress add column if not exists open_house_complete integer not null default 0;
alter table orientation_progress add column if not exists open_house_completed_at text;
