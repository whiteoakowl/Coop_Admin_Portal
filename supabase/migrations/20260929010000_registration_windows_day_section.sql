-- A real request: "main admin, classes, settings. Add registration
-- schedule. Be able to control who can signup on each schedule grid
-- monday/wednesday. Date, time and section and open for teacher or
-- assistant registration." A follow-up question confirmed this should
-- gate everyone who registers for a class (parents/students/teachers),
-- not just teacher/assistant - role_key already covers that. Day and
-- section narrow an existing registration_windows row to one schedule
-- grid / one Sections group, same "column present but null means
-- unrestricted" convention role_key already uses - a co-op with no
-- windows, or a window that leaves these blank, sees no behavior change.
alter table registration_windows add column if not exists day text check (day in ('monday', 'wednesday'));
alter table registration_windows add column if not exists section_id integer references sections(id) on delete set null;
-- Guarded (rather than a plain "create index if not exists") because
-- 20261031010000_registration_windows_action_types.sql later drops
-- section_id from this table - dropping a column also drops any index
-- built solely on it, so replaying this file after that migration has
-- already run once would otherwise recreate the index against a column
-- that's gone (the same real bug report as store_product_options' own
-- identical guard in 20260921010000_store_product_options.sql: "column
-- does not exist" on a second full run).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'registration_windows' and column_name = 'section_id'
  ) then
    create index if not exists idx_registration_windows_section on registration_windows(section_id);
  end if;
end $$;
