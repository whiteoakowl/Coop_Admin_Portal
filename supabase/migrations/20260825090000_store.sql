-- Community & Commerce track (Track B), item 8: Store. Checkout is wired
-- through item 9's own payment_charges/payment_payments abstraction
-- (utils/payments.js) rather than a separate "did they pay" flag on
-- store_orders - the handoff's own explicit instruction, why that
-- foundation was built first.

create table if not exists store_products (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  image_key text,
  price_cents integer not null check (price_cents >= 0),
  -- null = unlimited (a digital/no-inventory item, e.g. a fundraiser
  -- t-shirt pre-order with no cap) - decremented on every paid order,
  -- restored on cancellation, never trusted from a client.
  inventory_count integer,
  availability text not null default 'both' check (availability in ('online', 'in_person', 'both')),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

-- sale_type is the "must be recorded distinctly, not faked as a real
-- online transaction" requirement made structural, not just a status
-- string an admin could get wrong: an in-person sale is created through
-- its own dedicated admin action (routes/admin-store.js's own
-- recordInPersonSale, separate from the member-facing online checkout
-- route) and is paid immediately in that same action, while an online
-- order always starts 'pending' until a Main Admin records the payment
-- through the shared payment_charges abstraction.
create table if not exists store_orders (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  -- Who took the action: the buyer's own account for an online order,
  -- the recording admin's account for an in-person sale (member_id can
  -- be any member, including one with no portal account at all, for an
  -- in-person sale - a co-op kid buying a snack doesn't need a login).
  placed_by_account_id integer references member_accounts(id) on delete set null,
  sale_type text not null check (sale_type in ('online', 'in_person')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'fulfilled', 'cancelled')),
  charge_id integer references payment_charges(id) on delete set null,
  total_cents integer not null check (total_cents >= 0),
  created_at text not null default now_text(),
  fulfilled_at text,
  cancelled_at text
);
create index if not exists idx_store_orders_member on store_orders(member_id);

-- unit_price_cents is a snapshot of store_products.price_cents at order
-- time - a later price change must never retroactively change what a
-- past order shows as charged.
create table if not exists store_order_items (
  id integer generated always as identity primary key,
  order_id integer not null references store_orders(id) on delete cascade,
  product_id integer references store_products(id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null
);
create index if not exists idx_store_order_items_order on store_order_items(order_id);
