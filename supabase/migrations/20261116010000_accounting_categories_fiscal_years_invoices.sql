-- Several real requests bundled together under Accounting:
-- "Add an accounting category... pop up that asks for title and code" -
-- event_accounting_categories gets a short `code` alongside its existing
-- name (e.g. "RR" for "Registration & Renewals", matching the reference
-- screenshot's own Category dropdown wording).
alter table event_accounting_categories add column if not exists code text;

-- "Category subpage to say category/fiscal year... button for add a
-- fiscal year asking start and end date... appears on the fiscal year
-- table." A fiscal year is just a named date range an admin tracks
-- alongside accounting categories - nothing else in this app currently
-- scopes anything BY fiscal year, so this is deliberately just the list/
-- CRUD the request asked for, same shape as any other simple admin-
-- managed list (e.g. event_accounting_categories itself).
create table if not exists fiscal_years (
  id integer generated always as identity primary key,
  start_date text not null,
  end_date text not null,
  created_at text not null default now_text()
);

-- "Creating an invoice should look exactly like the screenshot" - the
-- screenshot's own fields that payment_charges didn't yet carry: a
-- Category dropdown (the same event_accounting_categories list Events'
-- own Finance tab already uses), a Due Date separate from the charge's
-- created_at "Date", Admin Notes, and the "Auto-Park/Unpark Family if/
-- when Unpaid/Paid?" checkbox. `email_family` just remembers the last
-- choice shown on the form - the actual "send or don't" decision happens
-- once at save time (routes/admin-accounting.js), not on every later view
-- of the invoice.
alter table payment_charges add column if not exists accounting_category_id integer references event_accounting_categories(id) on delete set null;
alter table payment_charges add column if not exists due_date text;
alter table payment_charges add column if not exists admin_notes text;
alter table payment_charges add column if not exists auto_park_family boolean not null default false;
alter table payment_charges add column if not exists email_family boolean not null default false;

-- "Accounting adjustment categories refund, exemption, credit, discount" -
-- Record Payment's own "Refund issued" direction (already payment_
-- payments.amount_cents < 0) now also picks which of these four a given
-- refund-direction row actually is, for Adjustments' own Type column.
-- Null for a plain payment - this only ever applies to a refund-direction
-- row.
alter table payment_payments add column if not exists adjustment_type text check (adjustment_type in ('refund', 'exemption', 'credit', 'discount'));

-- Backs the Auto-Park/Unpark checkbox above: recalculateParkedStatus
-- (utils/payments.js) flips this on for a member once any of their own
-- auto_park_family charges goes overdue unpaid, and back off once none
-- do - surfaced as a "Parked" badge on Accounting's own Accounts list/
-- Account page (the only place this flag changes anything - it doesn't
-- block registration/portal access, which was never asked for here).
alter table members add column if not exists parked boolean not null default false;
