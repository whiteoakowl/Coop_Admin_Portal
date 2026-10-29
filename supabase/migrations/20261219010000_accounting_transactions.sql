-- Accounting > Transactions subpage - a real request: "add a subpage
-- called transactions. Here we can link our bank account securely and
-- track all purchases that happen... Transactions are in a table on the
-- screen and filter can narrow down that list. Each item shows name,
-- date, total and dropdown to choose payment category. Purchases have a
-- receipt icon... upload an image of your receipt." A real bank-link
-- integration needs a chosen provider - no Plaid/Yodlee/Stripe wiring
-- exists anywhere in this app (confirmed by grep), and the answered
-- scoping question was manual entry for now, with a real bank feed
-- deferred until a provider is chosen. accounting_category_id reuses the
-- existing event_accounting_categories list (utils/events.js) rather
-- than inventing a second category table.
create table if not exists accounting_transactions (
  id integer generated always as identity primary key,
  type text not null check (type in ('income', 'expense')),
  name text not null,
  transaction_date text not null,
  amount_cents integer not null,
  accounting_category_id integer references event_accounting_categories(id) on delete set null,
  receipt_key text,
  receipt_name text,
  receipt_content_type text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_accounting_transactions_date on accounting_transactions(transaction_date);
create index if not exists idx_accounting_transactions_type on accounting_transactions(type);
