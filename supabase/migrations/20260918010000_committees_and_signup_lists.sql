-- A real request: "main admin portal, volunteer tab, sub pages
-- committees, sign up list, volunteer list." Three separate features,
-- each modeled after the shapes utils/events.js's own volunteer roles/
-- donation items already established for the exact same "a list of
-- slots, members claim one" pattern:
--   - committees: a standing (not per-event) group with named positions
--     members can sign up to help with, same role_name/slots_needed
--     shape as event_volunteer_roles/event_volunteer_signups.
--   - sign_up_lists: "a list of things for people to sign up for" - same
--     item_name/quantity_needed/claim shape as event_donation_items/
--     event_donation_claims.
--   - volunteer_signup_lists: "a list of jobs by date or hour that
--     members can sign up for" - its own shift_date/start_time/end_time
--     per slot, the one genuinely new shape here. Named
--     volunteer_signup_lists rather than volunteer_lists - see that
--     table's own comment below for why.
-- sign_up_lists/volunteer_signup_lists' own event_id is nullable ("be
-- able to attach these lists to events") - null means a standalone list
-- not tied to any one event, same "optional FK, null means unattached"
-- convention events.js's own category_id/location_id already use.

create table if not exists committees (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  leader_name text,
  contact_info text,
  enabled integer not null default 1,
  created_at text not null default now_text()
);

create table if not exists committee_positions (
  id integer generated always as identity primary key,
  committee_id integer not null references committees(id) on delete cascade,
  position_name text not null,
  slots_needed integer,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_committee_positions_committee on committee_positions(committee_id);

create table if not exists committee_signups (
  id integer generated always as identity primary key,
  position_id integer not null references committee_positions(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (position_id, member_id)
);
create index if not exists idx_committee_signups_position on committee_signups(position_id);
create index if not exists idx_committee_signups_member on committee_signups(member_id);

create table if not exists sign_up_lists (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  event_id integer references events(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_lists_event on sign_up_lists(event_id);

create table if not exists sign_up_list_items (
  id integer generated always as identity primary key,
  list_id integer not null references sign_up_lists(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_list_items_list on sign_up_list_items(list_id);

create table if not exists sign_up_list_claims (
  id integer generated always as identity primary key,
  item_id integer not null references sign_up_list_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_sign_up_list_claims_item on sign_up_list_claims(item_id);

-- Named volunteer_signup_lists, not volunteer_lists - that name is
-- already a real, unrelated table (the pre-existing Floater Assignments
-- feature's own day-based roster, supabase/migrations/
-- 20260811035644_initial_schema.sql). Same idea as sign_up_lists above
-- (an optional event_id), just with dated/timed shifts instead of items.
create table if not exists volunteer_signup_lists (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  event_id integer references events(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_volunteer_signup_lists_event on volunteer_signup_lists(event_id);

create table if not exists volunteer_signup_list_shifts (
  id integer generated always as identity primary key,
  list_id integer not null references volunteer_signup_lists(id) on delete cascade,
  job_name text not null,
  shift_date text,
  start_time text,
  end_time text,
  slots_needed integer not null default 1,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_volunteer_signup_list_shifts_list on volunteer_signup_list_shifts(list_id);

create table if not exists volunteer_signup_list_signups (
  id integer generated always as identity primary key,
  shift_id integer not null references volunteer_signup_list_shifts(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (shift_id, member_id)
);
create index if not exists idx_volunteer_signup_list_signups_shift on volunteer_signup_list_signups(shift_id);
create index if not exists idx_volunteer_signup_list_signups_member on volunteer_signup_list_signups(member_id);
