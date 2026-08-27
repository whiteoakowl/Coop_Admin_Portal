-- Main Admin Business Directory (Community & Commerce track, item 4) - a
-- real request: "Business Directory gets tabs: Directory, Requests,
-- Archive. Directory tab gets the same Add Category popup pattern
-- (admin-only add/delete categories)." Same admin-managed add/delete-only
-- category shape as classified_categories (see supabase/migrations/
-- 20260827090000_classified_categories.sql's own comment for the
-- reasoning this mirrors) - business_directory_listings.category_id
-- replaces its old free-text `category` column going forward; that old
-- column is left in place, unused, rather than dropped, so a real
-- deployed project never loses historical data on migrate.
create table if not exists business_directory_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table business_directory_listings add column if not exists category_id integer references business_directory_categories(id) on delete set null;
create index if not exists idx_business_directory_listings_category on business_directory_listings(category_id);
