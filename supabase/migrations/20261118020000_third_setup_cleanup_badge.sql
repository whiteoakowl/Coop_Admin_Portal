-- A real request: "for kiosk check out or in with setup/cleanup cards.
-- Currently it asks if you did a 2nd job. Also, add asking if you did a
-- 3rd job." Same shape as 20260901050000_second_setup_cleanup_badge.sql's
-- own 2nd-badge slot, one slot further - a member covering 3 Setup/
-- Cleanup jobs the same day now has somewhere for the 3rd to go, instead
-- of silently only ever being asked about 2.
alter table attendance add column if not exists task_item_id_3 integer references task_list_items(id) on delete set null;
alter table attendance add column if not exists task_scanned_at_3 bigint;
alter table checkouts add column if not exists task_item_id_3 integer references task_list_items(id) on delete set null;
