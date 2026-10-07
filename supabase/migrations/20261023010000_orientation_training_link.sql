-- A real request: "Orientation settings should be linking a training
-- already created under training to each selection. This was when a
-- member completes a training it will automatically register as
-- complete in the correct column next to the member." The existing
-- orientation_settings table (see 20261012010000_orientation_semesters.
-- sql) already lets each column's header link out to a plain URL - this
-- is a separate, deeper mechanism: an actual trainings.id reference per
-- column, read by utils/training.js's own maybeFinalizeAttempt to
-- auto-call setOrientationField whenever a member passes that training.
-- link_url now needs to be nullable too, since a column can have a
-- linked training with no header URL at all. Guarded because
-- 20261102010000_orientation_settings_drop_link_url.sql later drops
-- link_url entirely - replaying this file after that migration has
-- already run once would otherwise try to alter a column that's gone
-- (the same real bug report as store_product_options' own identical
-- guard in 20260921010000_store_product_options.sql: "column does not
-- exist" on a second full run).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'orientation_settings' and column_name = 'link_url'
  ) then
    alter table orientation_settings alter column link_url drop not null;
  end if;
end $$;
alter table orientation_settings add column if not exists training_id integer references trainings(id) on delete set null;
