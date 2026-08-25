-- Community & Commerce track (Track B), item 4: Business Directory and
-- Classifieds - built back to back per TEAM_B_HANDOFF.md since they share
-- the same shape: a member submits a listing, it starts 'pending' until a
-- Main Admin (manage_directory / manage_classifieds) approves it, then
-- it's visible per its own public/members visibility, same toggle Events
-- already established. An admin can also create/approve a listing
-- directly, so member_id can be any member (not just the submitter),
-- letting an admin list a business or item on someone else's behalf.

create table if not exists business_directory_listings (
  id integer generated always as identity primary key,
  member_id integer references members(id) on delete set null,
  business_name text not null,
  description text,
  category text,
  phone text,
  email text,
  website text,
  address text,
  image_key text,
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  -- 'pending': awaiting admin review, never shown outside admin
  -- management and the submitter's own "My Listings" view. 'active': live.
  -- 'archived': kept for history instead of deleted (matches events.status's
  -- own reasoning).
  status text not null default 'pending' check (status in ('pending', 'active', 'archived')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  approved_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_business_directory_status_visibility on business_directory_listings(status, visibility);
create index if not exists idx_business_directory_member on business_directory_listings(member_id);

create table if not exists classified_listings (
  id integer generated always as identity primary key,
  member_id integer references members(id) on delete set null,
  title text not null,
  description text,
  category text,
  -- Free text, not numeric - a real classifieds ad is as often "Free" or
  -- "Make an offer" as it is a fixed dollar amount, and this isn't an
  -- e-commerce checkout (that's the separate Store, item 8) where a real
  -- numeric price the code needs to total or charge would matter.
  price text,
  image_key text,
  visibility text not null default 'members' check (visibility in ('public', 'members')),
  status text not null default 'pending' check (status in ('pending', 'active', 'sold', 'archived')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  approved_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_classifieds_status_visibility on classified_listings(status, visibility);
create index if not exists idx_classifieds_member on classified_listings(member_id);
