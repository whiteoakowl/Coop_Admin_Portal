-- Community & Commerce track (Track B), item 9: Accounting/Payments
-- foundation - built ahead of item 8 (Store) even though the handoff
-- lists Store first, because the handoff's own item 9 text requires
-- Store's checkout to be wired through this same abstraction rather
-- than inventing a separate "did they pay" flag - the dependency runs
-- the opposite direction from the numbering. A payment ABSTRACTION only
-- - no real payment processor is integrated here, and no raw card data
-- is ever stored. A Main Admin (manage_finances) records real-world
-- payments (cash, check, Venmo, whatever the co-op actually uses)
-- against a charge after the fact; there is no online "pay now" button
-- anywhere in this app.

-- A charge is money owed by a member - a store order, an event
-- registration fee, or a manual charge an admin records by hand
-- (source_type/source_id together point back at the thing that created
-- it, when there is one; both are null for a manual charge).
create table if not exists payment_charges (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  account_id integer references member_accounts(id) on delete set null,
  source_type text not null default 'manual' check (source_type in ('store_order', 'event_registration', 'manual')),
  source_id integer,
  description text not null,
  amount_cents integer not null check (amount_cents >= 0),
  -- Recomputed by utils/payments.js's own recordPayment() from the real
  -- payment_payments rows against this charge every time one is added -
  -- never set directly to 'paid'/'refunded' by a route, so this can
  -- never drift from what was actually recorded.
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_payment_charges_member on payment_charges(member_id);
create index if not exists idx_payment_charges_source on payment_charges(source_type, source_id);

-- One row per real-world payment or refund against a charge - positive
-- amount_cents for a payment, negative for a refund, so a charge's own
-- "amount actually settled" is always a plain SUM() over these, the same
-- "never trust a cached total" principle every other running total in
-- this app already follows (event registration counts, donation
-- quantities claimed, etc.).
create table if not exists payment_payments (
  id integer generated always as identity primary key,
  charge_id integer not null references payment_charges(id) on delete cascade,
  amount_cents integer not null,
  -- 'manual' is every real payment today (recorded by an admin after
  -- money changed hands outside this app); 'stripe_placeholder' exists
  -- only so the abstraction has somewhere to grow into a real processor
  -- later without a schema change - nothing in this codebase sets it yet.
  method text not null default 'manual' check (method in ('manual', 'stripe_placeholder')),
  recorded_by_account_id integer references member_accounts(id) on delete set null,
  note text,
  created_at text not null default now_text()
);
create index if not exists idx_payment_payments_charge on payment_payments(charge_id);
