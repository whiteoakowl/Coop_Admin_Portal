-- Staged, group-targeted class registration windows - the "teachers
-- first, then certain families, then everyone" scope the portal
-- foundation migration (20260825020000) called out as intentionally not
-- built there. A window targets an EXISTING role (reusing the roles
-- table rather than inventing a second "member group" concept) or
-- nobody in particular (role_key null = everyone). A class only accepts
-- registrations once BOTH its own registration_open flag is set AND, if
-- any windows exist at all, the registering parent qualifies for one
-- that's currently open - see routes/parent-portal.js's
-- windowIsOpenForAccount for the exact rule, including the "no windows
-- defined at all" back-compat case.
create table if not exists registration_windows (
  id integer generated always as identity primary key,
  label text not null,
  role_key text references roles(key) on delete cascade,
  opens_at text not null,
  closes_at text,
  created_at text not null default now_text()
);
-- Guarded (rather than a plain "create index if not exists") because
-- 20261031010000_registration_windows_action_types.sql later drops
-- role_key from this table - dropping a column also drops any index
-- built solely on it, so replaying this file after that migration has
-- already run once would otherwise recreate the index against a column
-- that's gone (the same real bug report as store_product_options' own
-- identical guard in 20260921010000_store_product_options.sql: "column
-- does not exist" on a second full run).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'registration_windows' and column_name = 'role_key'
  ) then
    create index if not exists idx_registration_windows_role on registration_windows(role_key);
  end if;
end $$;
