-- Resource Links - Student Portal item: "resource links" tab. A short,
-- admin-curated list of external links (a Google Classroom folder, a
-- reading list, a permission-slip form, etc.), not a document library or
-- checkout system (that's the EXISTING Library feature - utils/
-- library.js - a different, physical-item-checkout concept). role_key
-- optionally scopes a link to one portal's audience, the same
-- null-means-everyone convention routes/main-admin-announcements.js's own
-- roleKey already uses for "Send to"; left null a link shows up for every
-- signed-in portal account, same as an unscoped announcement.
create table if not exists resource_links (
  id integer generated always as identity primary key,
  title text not null,
  url text not null,
  description text,
  role_key text references roles(key) on delete cascade,
  position integer not null default 0,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
-- Guarded (rather than a plain "create index if not exists") because
-- 20261108010000_resource_link_roles.sql later drops role_key from this
-- table - dropping a column also drops any index built solely on it, so
-- replaying this file after that migration has already run once would
-- otherwise recreate the index against a column that's gone (the same
-- real bug report as store_product_options' own identical guard in
-- 20260921010000_store_product_options.sql: "column does not exist" on
-- a second full run).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'resource_links' and column_name = 'role_key'
  ) then
    create index if not exists idx_resource_links_role on resource_links(role_key);
  end if;
end $$;
