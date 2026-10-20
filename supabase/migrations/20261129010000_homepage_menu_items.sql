-- Public Homepage - a real follow-up request: "Should be able to edit
-- or add menu tabs to the homepage." homepage_blocks (the earlier
-- homepage_builder migration) only ever covered the page's own body
-- content; the public site header above it (views/public-home.ejs) had
-- no navigation menu at all - just the org brand mark and Log In/
-- Register. This is that menu: an ordered, admin-editable list of
-- label+URL links shown in the homepage's own header, same "ordered
-- list a drag-and-drop canvas manages" shape homepage_blocks already
-- uses (see utils/homepage.js).
create table if not exists homepage_menu_items (
  id integer generated always as identity primary key,
  position integer not null default 0,
  label text not null,
  url text not null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_homepage_menu_items_position on homepage_menu_items(position);
