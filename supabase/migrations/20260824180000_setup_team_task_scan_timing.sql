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
