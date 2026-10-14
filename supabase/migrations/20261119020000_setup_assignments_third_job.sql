-- Real request: "Add being able to assign a 3rd job on setup/cleanup
-- assignments." Mirrors the existing task_item_id_2 slot (added for "a
-- small team routinely needs one member covering two jobs") with a third,
-- independent slot - same "fixed shape, not a list" reasoning: the
-- Assignments page now always shows exactly three dropdowns per member
-- (see partials/setup-assignment-cards.ejs), so a third nullable column
-- continues that pattern rather than modeling a variable-length list
-- nothing here needs.
alter table setup_task_assignments add column if not exists task_item_id_3 integer references task_list_items(id) on delete set null;
