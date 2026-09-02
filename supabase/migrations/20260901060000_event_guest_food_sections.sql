-- Main Admin Events - a real, large request bundled into one migration:
--
-- "guests can register should only be a check box under who can register
-- with parent and student options" - allow_guest_register joins
-- allow_adult_register/allow_child_register as a third per-event "who
-- can register" toggle (Permissions), independent of the register_guests
-- PORTAL PERMISSION (db/bootstrapPg.js) that already controls whether a
-- given admin is even allowed to add a walk-in guest at all - this is
-- the per-EVENT switch for whether guest registration is offered on
-- this event in the first place.
--
-- "capacity totals dropdown choosing family or person capacity" -
-- collapses the Create/Edit forms' two separate numeric fields
-- (capacity, family_capacity) into one number + a type picker - no
-- schema change needed there, both columns already exist (see
-- routes/admin-events.js's own capacityValue/capacityType handling).
--
-- "on the volunteer, donations and food pages. there will be a check
-- box for, do you want to include this section? then a dropdown menu
-- of numbers 1-50 that ask, how many volunteer/donation/food items
-- should each family/individual registration select" - three parallel
-- (enabled, selection_count) pairs, one per section. *_enabled defaults
-- to 1 (on) for volunteers/donations since those two sections already
-- exist and are already live on every event today - turning this
-- migration on must not silently hide a section admins are already
-- using. food_enabled defaults to 0 since Food is a brand new section
-- nothing has opted into yet. *_selection_count is nullable (no stored
-- minimum) until an admin actually sets one from the dropdown.
alter table events add column if not exists allow_guest_register integer not null default 0;
alter table events add column if not exists volunteers_enabled integer not null default 1;
alter table events add column if not exists donations_enabled integer not null default 1;
alter table events add column if not exists food_enabled integer not null default 0;
alter table events add column if not exists volunteer_selection_count integer;
alter table events add column if not exists donation_selection_count integer;
alter table events add column if not exists food_selection_count integer;

-- Food items - a brand new third section alongside the existing
-- Volunteer Roles/Donation Items, same shape as event_donation_items/
-- event_donation_claims exactly (a potluck-style "bring an item" sign-up
-- sheet, claimed by members the same way a donation item already is).
create table if not exists event_food_items (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  deadline text,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_food_items_event on event_food_items(event_id);

create table if not exists event_food_claims (
  id integer generated always as identity primary key,
  food_item_id integer not null references event_food_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_event_food_claims_item on event_food_claims(food_item_id);

alter table public.event_food_items enable row level security;
alter table public.event_food_claims enable row level security;
