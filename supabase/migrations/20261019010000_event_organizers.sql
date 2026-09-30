-- A real request: "Organized by should be a drop down to choose Sanford
-- Homeschoolers or a parent name. Can select multiple. Will show on
-- parent portal who Organized the event and their email address."
-- events.organized_by (a free-text field) can't answer "their email
-- address" - showing a parent's real email means linking to their real
-- members row, not whatever text an admin typed. organized_by itself is
-- left in the schema unused, same "retired but not dropped column"
-- pattern as e.g. events.language.
--
-- A null member_id row is the fixed "Sanford Homeschoolers" option -
-- there's only ever one of those per event, and it has no member/email
-- of its own to look up.
create table if not exists event_organizers (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  member_id integer references members(id) on delete cascade,
  created_at text not null default now_text()
);
create index if not exists idx_event_organizers_event on event_organizers(event_id);
