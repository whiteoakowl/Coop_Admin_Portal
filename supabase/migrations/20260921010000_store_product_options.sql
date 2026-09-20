-- A real request: "Store, adding options to a product should be a row
-- with a bar for the option title and the individual price next to it,
-- and box for qty and enable/disable button." Replaces the old plain
-- comma-separated store_products.sizes text (no per-size price or
-- stock) with a real per-option row: its own price (not a delta off the
-- product's base price - some options are simply priced differently),
-- its own stock count (same null-means-unlimited shape as store_products.
-- inventory_count), and its own enabled flag (a temporarily-unavailable
-- option stays on the product instead of being deleted and losing its
-- history). store_products.sizes/store_order_items.size are left in
-- place, untouched, so every pre-existing order still displays exactly
-- what it always did - only new code stops reading/writing them.
create table if not exists store_product_options (
  id integer generated always as identity primary key,
  product_id integer not null references store_products(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  quantity integer,
  enabled integer not null default 1,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_store_product_options_product on store_product_options(product_id);

-- No automatic backfill from the old sizes text - a size never carried
-- its own price or stock, so there's nothing to carry over beyond the
-- label itself. views/admin-store-edit.ejs shows any pre-existing sizes
-- as a plain read-only hint (only while a product has no options yet) so
-- an admin who already set them up notices and re-enters them as real
-- options instead of losing them silently.

-- order_id kept snapshot-first, same reasoning as store_order_items'
-- existing unit_price_cents/size columns: option_id is nullable (a later
-- edit to a product's own options list clears and re-inserts every row,
-- see utils/store.js's own setProductOptions - a past order must never
-- point at a since-replaced row) while option_name is a permanent text
-- snapshot of whichever option was actually chosen.
alter table store_order_items add column if not exists option_id integer references store_product_options(id) on delete set null;
alter table store_order_items add column if not exists option_name text;
