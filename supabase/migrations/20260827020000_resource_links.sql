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
create index if not exists idx_resource_links_role on resource_links(role_key);
