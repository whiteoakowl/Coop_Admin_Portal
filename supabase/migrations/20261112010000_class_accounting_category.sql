-- A real request: "class edit details... after charge per add a dropdown
-- choice for account category." Reuses the SAME admin-managed accounting
-- category list Events already have (event_accounting_categories,
-- see 20260924010000_event_ticket_types_and_accounting_category.sql) -
-- despite the "event_" prefix, it's really just the co-op's own
-- bookkeeping category list, not event-specific data, and classes
-- picking from that same list (managed in one place under Events'
-- Settings tab) is simpler than standing up a second, parallel
-- "class accounting category" list an admin would have to keep in sync.
alter table classes add column if not exists accounting_category_id integer references event_accounting_categories(id) on delete set null;
