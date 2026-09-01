-- Real request: "after parent scans their setup/cleanup badge it should
-- ask if they have a 2nd setup/cleanup badge to scan, with yes and no
-- buttons. if they select yes, it allows them to scan their barcode...
-- after the 2nd badge entry the screen says thank you! and goes back to
-- the home screen. if they select no, it's says thank you! and goes
-- back to the home screen." A parent covering two Setup/Cleanup jobs the
-- same day is already a modeled case (setup_task_assignments.task_item_id_2,
-- see that migration's own comment - a member routinely covers two jobs
-- at once), so both scan points that record a completed task -
-- attendance (routes/kiosk.js's /checkin/task-scan) and checkouts
-- (routes/checkout.js's /checkout/task-scan) - get a second slot to
-- record a second badge in, mirroring their existing single task_item_id
-- column exactly. attendance.task_scanned_at_2 mirrors task_scanned_at -
-- the "was a 2nd badge actually scanned" signal, distinct from
-- task_item_id_2 being null for a legitimate reason (declined the 2nd
-- badge, or a bypass-badge scan).
alter table attendance add column if not exists task_item_id_2 integer references task_list_items(id) on delete set null;
alter table attendance add column if not exists task_scanned_at_2 bigint;
alter table checkouts add column if not exists task_item_id_2 integer references task_list_items(id) on delete set null;
