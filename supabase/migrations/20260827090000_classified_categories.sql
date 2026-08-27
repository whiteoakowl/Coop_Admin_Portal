-- Main Admin Classifieds (Community & Commerce track, item 4) - a real
-- request: "Only admin can add classifieds categories (same Add Category
-- popup pattern to add/delete). Members must choose a category when
-- creating a listing. Admin Classifieds gets tabs: Categories, Archive,
-- Requests." Same admin-managed add/delete-only category shape as
-- resource_link_categories (see supabase/migrations/
-- 20260825060000_forums.sql's sibling, 20260825050000-era resource links
-- migration) - classified_listings.category_id replaces its old free-text
-- `category` column going forward; that old column is left in place,
-- unused, rather than dropped, so a real deployed project never loses
-- historical data on migrate.
create table if not exists classified_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table classified_listings add column if not exists category_id integer references classified_categories(id) on delete set null;
create index if not exists idx_classified_listings_category on classified_listings(category_id);
