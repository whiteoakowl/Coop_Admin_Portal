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
