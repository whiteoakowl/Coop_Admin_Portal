-- A real request: "resource links, add resource, show on choosing a
-- portal dropdown should be a clean checkbox dropdown. Checkboxes next
-- to each portal." Replaces the single nullable role_key column (one
-- role, or null meaning everyone) with a many-to-many table, same
-- empty-means-unrestricted convention as forum_category_sections.
create table if not exists resource_link_roles (
  resource_link_id integer not null references resource_links(id) on delete cascade,
  role_key text not null references roles(key) on delete cascade,
  primary key (resource_link_id, role_key)
);

-- Guarded by an information_schema check (same real bug report as
-- 20261005010000_store_option_groups.sql's own identical guard: running
-- this whole consolidated file a second time - it's meant to be safe to
-- replay in full - failed with "column role_key does not exist", since
-- the first run's own DROP COLUMN below already removed it by the time
-- this INSERT's query was re-parsed).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'resource_links' and column_name = 'role_key'
  ) then
    insert into resource_link_roles (resource_link_id, role_key)
      select id, role_key from resource_links where role_key is not null
      on conflict do nothing;

    alter table resource_links drop column if exists role_key;
  end if;
end $$;
