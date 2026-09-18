-- Real request: "do the admin shop features" - product categories (for
-- the Shop's own category filter and a Settings tab to manage them,
-- same admin-managed add/rename/delete shape as classified_categories)
-- plus per-product sizes: a comma-separated list of size labels a buyer
-- picks one of at checkout (e.g. a co-op hoodie's "S,M,L,XL"). Null sizes
-- means the product has none to choose from - same "opt-in" shape as
-- inventory_count's own null-means-unlimited.
create table if not exists store_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default now_text()
);

alter table store_products add column if not exists category_id integer references store_categories(id) on delete set null;
alter table store_products add column if not exists sizes text;
create index if not exists idx_store_products_category on store_products(category_id);

-- A snapshot of the size the buyer picked, same reasoning as
-- unit_price_cents right above it in the original store migration - a
-- later change to a product's available sizes must never retroactively
-- change what a past order shows as bought. Null for a product with no
-- sizes.
alter table store_order_items add column if not exists size text;
