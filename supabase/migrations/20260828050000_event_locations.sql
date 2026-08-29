-- Main Admin > Events Settings (item 8) - a real request: "buttons for
-- add/edit category, add/edit location. Both create a popup that allows
-- you to add/edit or delete categories or locations. Locations will then
-- also be a dropdown menu of choices when creating events instead of
-- typing in addresses when creating each event." Same shape/reasoning as
-- event_categories (20260826040000_events_registration_rules.sql) - a
-- fixed, Main-Admin-managed list an event picks one of instead of every
-- admin typing their own free text. The original events.location
-- free-text column is left in place (untouched, still populated on old
-- rows) rather than migrated - new events use location_id instead,
-- same "legacy text column stays, new events use the FK" pattern
-- events.category/category_id already established.
create table if not exists event_locations (
  id integer generated always as identity primary key,
  name text not null unique,
  address text,
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists location_id integer references event_locations(id) on delete set null;
