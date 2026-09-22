-- A real request: "Shop, add option will be a drop down menu on parent/
-- student portals. On main admin shop, product, when you add an option
-- there will be sub categories to add variables, each with their own
-- price. This setup is like shopify." Confirmed with the requester:
-- a product can have several option groups at once (e.g. "Size" AND
-- "Color"), each rendered as its own dropdown at checkout; not every
-- group's values carry their own price - the final price defaults to
-- whichever one value has a set price, or sums every priced value's
-- price if more than one group has one (an unset price contributes $0).
-- Replaces the flat per-product options list from
-- 20260921010000_store_product_options.sql with a two-level
-- Group -> Values hierarchy.
create table if not exists store_product_option_groups (
  id integer generated always as identity primary key,
  product_id integer not null references store_products(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_store_product_option_groups_product on store_product_option_groups(product_id);

-- A value now belongs to a group instead of directly to a product, and
-- a value's price is optional (null = adds nothing beyond the base
-- product price, or beyond whatever another group's value already
-- prices it at) - "not all groups have separate price."
alter table store_product_options add column if not exists group_id integer references store_product_option_groups(id) on delete cascade;
alter table store_product_options alter column price_cents drop not null;

-- Backfill: every product that already had flat options gets one
-- default group ("Options") so its existing values keep working as a
-- single dropdown, unchanged from a buyer's point of view.
insert into store_product_option_groups (product_id, name, position)
select distinct product_id, 'Options', 0
from store_product_options
where group_id is null;

update store_product_options o
set group_id = g.id
from store_product_option_groups g
where o.group_id is null and g.product_id = o.product_id and g.name = 'Options';

-- Every value is now reached through its group (group_id, set not null
-- above) rather than directly by product - product_id here is now
-- redundant with store_product_option_groups.product_id.
alter table store_product_options alter column group_id set not null;
alter table store_product_options drop column if exists product_id;

-- One row per selected value per line item, since a line item can now
-- have one selection per group instead of at most one option overall.
-- store_order_items.option_name stays a single COMBINED snapshot string
-- (every selected value's group+name joined together) so the existing
-- fulfillmentTotals()/salesAnalytics() reports (both GROUP BY
-- i.option_name) need no changes; this table is the detailed breakdown
-- behind that combined string.
create table if not exists store_order_item_options (
  id integer generated always as identity primary key,
  order_item_id integer not null references store_order_items(id) on delete cascade,
  option_id integer references store_product_options(id) on delete set null,
  group_name text not null,
  option_name text not null,
  price_cents integer,
  created_at text not null default now_text()
);
create index if not exists idx_store_order_item_options_item on store_order_item_options(order_item_id);
