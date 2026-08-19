-- Real request: "setup/cleanup team cards should have a space for time to
-- meet and meeting location. the leader, time, location, all those
-- details should show on the kiosk side when you click the setup/cleanup
-- button." Both nullable free text (matching setup_teams.description's own
-- shape) - a team without a fixed time/place yet just shows nothing extra,
-- same as a team with no leader or description today.
alter table setup_teams add column if not exists meeting_time text;
alter table setup_teams add column if not exists meeting_location text;
