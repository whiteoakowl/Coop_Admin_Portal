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
create index if not exists idx_registration_windows_role on registration_windows(role_key);
