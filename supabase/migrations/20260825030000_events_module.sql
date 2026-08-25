-- Community & Commerce track (Track B), item 1: Events. The backbone
-- other Track B features (volunteer/donation signups now, the Newsletter
-- and Notification Center later) hang off of - see TEAM_B_HANDOFF.md.
--
-- Registration reuses the "attendee is a members row, action is logged
-- against the signed-in member_account" shape Track A's own
-- class_registrations already established (routes/parent-portal.js) -
-- same reasoning: a parent portal account can register any of their own
-- family's members (including themselves) for an event, not just
-- themselves, and every action still has a real accountable actor.

create table if not exists events (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  category text,
  location text,
  -- Local-disk or Supabase Storage key (utils/storage.js's own
  -- convention - see routes/admin-documents.js), not a raw URL, so this
  -- follows the same storage-backend-agnostic pattern every other upload
  -- in this app already uses. Null is a perfectly normal event with no
  -- image.
  image_key text,
  starts_at text not null,
  ends_at text,
  -- 'public': shown on the public site to signed-out visitors too.
  -- 'members': only shown to a signed-in portal account (any role) - the
  -- "public/member visibility" toggle the handoff calls for.
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  capacity integer,
  -- 'draft' never appears anywhere outside admin event management.
  -- 'published' is live. 'cancelled' stays visible (with a cancelled
  -- badge) rather than being deleted, so existing registrations/
  -- volunteer signups/donation claims keep their history intact.
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_events_starts_at on events(starts_at);
create index if not exists idx_events_status_visibility on events(status, visibility);

create table if not exists event_registrations (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  registered_by_account_id integer references member_accounts(id) on delete set null,
  -- 'confirmed' or 'waitlisted' (capacity enforcement, same status shape
  -- as class_registrations), 'cancelled' keeps the row instead of
  -- deleting it - real registration history for admin reporting.
  status text not null default 'confirmed' check (status in ('confirmed', 'waitlisted', 'cancelled')),
  created_at text not null default now_text(),
  cancelled_at text,
  unique (event_id, member_id)
);
create index if not exists idx_event_registrations_event on event_registrations(event_id);
create index if not exists idx_event_registrations_member on event_registrations(member_id);

-- Per-event volunteer roles (handoff item 2) - "role name, number needed,
-- time, location, description". position orders them on the event page,
-- same ordering convention as e.g. setup_teams' own task lists.
create table if not exists event_volunteer_roles (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  role_name text not null,
  slots_needed integer not null default 1,
  time_label text,
  location text,
  description text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_volunteer_roles_event on event_volunteer_roles(event_id);

create table if not exists event_volunteer_signups (
  id integer generated always as identity primary key,
  volunteer_role_id integer not null references event_volunteer_roles(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  signed_up_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  unique (volunteer_role_id, member_id)
);
create index if not exists idx_event_volunteer_signups_role on event_volunteer_signups(volunteer_role_id);

-- Per-event donation/item requests (handoff item 3) - "item, quantity
-- needed/claimed, deadline". quantity_claimed is a real live SUM of
-- event_donation_claims.quantity_claimed, computed on read (utils/
-- events.js), never stored - the same "don't let a cached counter drift
-- from its own source of truth" principle the rest of this app already
-- follows for e.g. class enrollment counts.
create table if not exists event_donation_items (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  item_name text not null,
  quantity_needed integer not null default 1,
  deadline text,
  notes text,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_donation_items_event on event_donation_items(event_id);

create table if not exists event_donation_claims (
  id integer generated always as identity primary key,
  donation_item_id integer not null references event_donation_items(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  quantity_claimed integer not null default 1,
  claimed_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_event_donation_claims_item on event_donation_claims(donation_item_id);
