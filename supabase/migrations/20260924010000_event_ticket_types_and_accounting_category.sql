-- A real request: "event settings, finance, if charging per person there
-- should be an option for adding several types of tickets with a
-- different price and title bar next to it. Add a drop down menu for
-- choosing accounting category." Admin-side only for now (a scoping
-- question confirmed this) - registration still charges the event's own
-- flat price_cents; wiring an actual ticket-type CHOICE into registration
-- and charging is a separate follow-up.

-- One event can offer several named price tiers ("Adult", "Child",
-- "VIP", ...) once it's charging per person - same has-many-rows-owned-
-- by-one-event shape as event_volunteer_roles/event_donation_items/
-- event_food_items (cascade-deleted with the event, no separate
-- "enabled" toggle needed since an empty list already means "no ticket
-- types defined").
create table if not exists event_ticket_types (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  title text not null,
  price_cents integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_ticket_types_event on event_ticket_types(event_id);

-- Main-Admin-managed, same shape/reasoning as event_categories (see
-- 20260826040000_events_registration_rules.sql) - a fixed list an event
-- picks one of, for internal bookkeeping rather than the public-facing
-- Category dropdown (Social/Fundraiser/etc.) events already have.
create table if not exists event_accounting_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists accounting_category_id integer references event_accounting_categories(id) on delete set null;
