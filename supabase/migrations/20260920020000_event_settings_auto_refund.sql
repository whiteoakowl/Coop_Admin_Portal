-- A real request: "new settings, automatically issue refund if member
-- cancels their registration" - a new Main Admin > Events > Settings
-- toggle, same "stored, ready to wire up once a real refund/payment
-- system exists" shape as credit_on_family_cancel/credit_on_admin_cancel
-- next to it (see 20260829010000_event_settings.sql's own header
-- comment).
alter table event_settings add column if not exists auto_refund_on_family_cancel integer not null default 0;
